# Gameplay kit (`@gaime/core/kit`)

The kit is a set of small gameplay building blocks: proximity queries, collision tests, projectiles, timers, a match lifecycle, turn order, inventories, randomness, team colours, visual effects and top-down movement.

```ts
import { cooldown, raycast, stepProjectiles, stepMatch } from '@gaime/core/kit';
```

## Conventions

- **Pure functions over plain data.** Nothing in the kit touches the network, the clock or globals. The same code runs on the server (simulation), on the client (prediction, previews) and in tests.
- **State lives in the world.** Timers, statuses, match and turn state are stored in plain records and objects inside your `World` (a player's `cooldowns`, an entity's `data`, `world.match`). This means they survive checkpoints and hot reloads, and they are synchronised like any other field. Never use `setTimeout` for game logic. `time` is always `world.time` (seconds, stops while the game is paused).
- **Mutation.** Functions that take an object and return nothing change it in place (`separate`, `clampToCircle`, `moveTopDown`, `stepProjectiles`, `setReady`...). The exception is `pruneEffects`, which returns a new array.
- **The x/z plane.** Every position is a `Vec2 = { x: number; z: number }` (exported from `@gaime/core`). Top-down games use x/z as the ground plane (Three.js y is up). Side-view games (artillery, platformers) treat **z as "up"**, and gravity then points to -Z.
- **Angles.** Kit angles are **radians measured from +Z**: `0` points to +Z, `Math.PI / 2` to +X. That is the same as `angleTo` and Three.js `rotation.y` for a model facing +Z. The direction of angle `a` is `{ x: Math.sin(a), z: Math.cos(a) }`. **The one exception is `ballisticAngle`**, which returns radians from +X towards +Z (an elevation angle for side views). Convert it with `Math.PI / 2 - angle` before you pass it to `launch`.
- **Randomness.** Functions that need randomness take a `random: () => number` argument. On the server, pass `ctx.random` — the world's own generator, which keeps the game deterministic and replayable; never `Math.random`. In unit tests, pass `seeded(n)` from `@gaime/core` to get reproducible results (in `testGame`, seed the world instead: `{ seed: n }`).

See [ARCHITECTURE.md](ARCHITECTURE.md) for how the world, `step` and hot reload fit together, and [SERVER.md](SERVER.md) for `GameContext`.

---

## Spatial: `SpatialHash`

This is a uniform grid for proximity queries on the x/z plane. Rebuild it once per tick from the current entities, then ask "who is near this point" in about O(1) instead of O(n). It pays off from roughly a hundred entities. Below that, a plain loop (or `nearest` from `@gaime/core`) is fine.

**On the server, prefer the engine's shared index**: list the collection in `GameDefinition.spatial` and query it with `ctx.near` / `ctx.nearest`. The engine then builds one grid per collection per tick for every system and module together, checks live positions, skips deleted entities and reports its cost in `/gaime/stats` ([SIMULATION.md](SIMULATION.md#spatial-index)). Use `SpatialHash` directly on the client, in workers, or for sets of things that are not a top-level world collection.

```ts
class SpatialHash<T extends Vec2> {
  constructor(cellSize?: number);            // default 4; throws unless > 0
  readonly cellSize: number;
  clear(): void;
  insert(item: T): void;
  rebuild(items: Iterable<T>): this;         // clear + insert all; chainable
  query(from: Vec2, radius: number, filter?: (item: T) => boolean): T[];
  nearest(from: Vec2, radius: number, filter?: (item: T) => boolean): T | undefined;
}
```

- `query` returns the items whose position is within `radius` of `from`, boundary included, in no particular order. It visits every cell overlapping the square around the circle. Pick a `cellSize` close to your typical query radius.
- `nearest` returns the closest item within `radius`, or `undefined`. On a tie, the first item found wins.
- Items are stored by reference, and their position is read when they are inserted. If they move, rebuild the grid.
- Cell keys are exact while the cell coordinates stay within |x / cellSize| < 2^27 and |z / cellSize| < 2^25, far beyond any game map.
- **Do not store the grid in the world.** It is not serialisable. Create it inside the system that uses it, or keep it in `ctx.resource('<module>-grid', () => new SpatialHash(4))` and rebuild it every tick — not in a module-level variable. It never holds state that must survive a reload.

```ts
const grid = new SpatialHash<Enemy>(4).rebuild(Object.values(world.enemies));
for (const player of Object.values(world.players)) {
  for (const enemy of grid.query(player, 6, e => e.hp > 0)) enemy.hp -= 10 * dt;
}
```

---

## Collision

Every collision function works on the x/z plane.

```ts
interface Rect { x: number; z: number; width: number; depth: number }   // (x, z) = min corner; width along X, depth along Z
interface RayHit<T> { item: T; distance: number; point: Vec2 }
```

| Function | Returns | Behaviour |
| --- | --- | --- |
| `circlesOverlap(a, ra, b, rb)` | `boolean` | True when the two circles overlap. Touching counts. |
| `pointInRect(point, rect)` | `boolean` | Edges are inclusive. |
| `circleRect(center, radius, rect)` | `boolean` | Circle against an axis-aligned rectangle (closest-point test). Touching counts. |
| `rayCircle(origin, direction, maxDistance, center, radius)` | `number \| null` | Distance along the ray to the first contact. `direction` must be a unit vector. Returns `0` when `origin` is inside the circle, and `null` when the ray misses, the circle is behind the origin, or the contact is beyond `maxDistance`. |
| `raycast(origin, angle, range, items, radiusOf, filter?)` | `RayHit<T> \| undefined` | Hitscan. Returns the closest item whose circle (`radiusOf(item)`) is crossed by a ray from `origin` at `angle` (radians from +Z) within `range`. `point` is the contact point. |
| `rayEnd(origin, angle, distance)` | `Vec2` | End point of a ray that hit nothing (for tracers). |
| `separate(items, radiusOf, strength = 0.5)` | `void` | Soft crowd separation. Mutates positions. Overlapping pairs are pushed apart along the line between their centres, each item by `overlap * strength`. With `0.5`, a single pair is fully resolved in one pass. Cost is O(n²): fine for a few hundred items. Beyond that, use `separateWith`. Items at exactly the same position (distance < 1e-6) are pushed apart too, in a deterministic direction per pair. |
| `separateWith(items, radiusOf, neighbours, strength = 0.5)` | `void` | The same, for crowds: each item is only checked against `neighbours(item)` — usually the engine's index, `e => ctx.near('enemies', e, radiusOf(e) + maxRadius)` — so it costs O(n·k). Items need string `id`s; each pair is resolved once. `games/starter` uses it for its waves. |
| `clampToCircle(point, radius, margin = 0)` | `void` | Keeps a point inside a circle of `radius` **around the origin (0, 0)**. Pass the entity's own radius as `margin`. |
| `keepOutOfCircle(point, center, radius)` | `void` | Pushes a point outside a circle (a central building, a pillar), onto its edge. A point exactly at the centre is pushed to +X. |
| `clampToRect(point, rect, margin = 0)` | `void` | Keeps a point inside a rectangle, `margin` away from its edges. |

```ts
// Hitscan shot along the player's facing angle (games/starter/src/server/simulation.ts)
const hit = raycast(player, player.angle, RULES.shotRange, Object.values(world.enemies), e => defs[e.kind]?.radius ?? 0.5);
const end = hit?.point ?? rayEnd(player, player.angle, RULES.shotRange);
addEffect(world.effects, ctx.nextId(), 'tracer', world.time, player, { x2: end.x, z2: end.z, color: player.color });
if (hit) hurtEnemy(hit.item, RULES.shotDamage, player.id);

// Arena bounds shared by server and client prediction (games/starter/src/shared/rules.ts)
clampToCircle(player, RULES.arenaRadius, RULES.playerRadius);
keepOutOfCircle(player, { x: 0, z: 0 }, RULES.crystalRadius + RULES.playerRadius);
```

---

## Projectiles

Simulated projectiles (bullets, grenades, artillery shells) are plain world data. Keep them in a `Record<string, Projectile>` in your `World` and list that key in `network.entities` (see [reference/CONFIG.md](reference/CONFIG.md#networkconfig)).

```ts
interface Projectile {
  id: string;
  kind: string;            // definition id (weapon, spell…): look up damage/radius in your registry
  owner: string;
  x: number; z: number;
  vx: number; vz: number;
  radius: number;          // collision radius
  expiresAt: number;       // world time when it expires
  data: Record<string, number | string | boolean>;   // free-form; prefix keys with your module id
}
```

### `launch(options: LaunchOptions): Projectile`

```ts
interface LaunchOptions {
  id: string; kind: string; owner: string;
  from: Vec2;
  angle: number;           // radians from +Z
  speed: number;
  radius?: number;         // default 0.2
  life?: number;           // seconds of flight, default 3
  time: number;            // world.time
  data?: Projectile['data'];   // copied shallowly
}
```

`launch` builds a projectile with `vx = sin(angle) * speed` and `vz = cos(angle) * speed`, and `expiresAt = time + life`. It does not insert the projectile into any record. Do that yourself.

### `stepProjectiles<T>(projectiles, options: StepProjectilesOptions<T>): void`

This moves every projectile in the record, resolves hits and deletes finished projectiles. Call it once per tick from `step`.

```ts
interface StepProjectilesOptions<T> {
  dt: number;
  time: number;                                          // world.time
  gravity?: Vec2;                                        // constant acceleration, units/s²
  accelerate?(projectile: Projectile): Vec2 | undefined; // extra per-projectile acceleration (wind, homing)
  hit?(projectile: Projectile): T | undefined;           // what it hits at its current position (a target with an `id` at most once)
  solid?(point: Vec2): boolean;                          // true inside ground / walls
  onImpact?(projectile: Projectile, target: T | undefined, point: Vec2): boolean | void;  // return true to keep it alive
  onExpire?(projectile: Projectile): void;
  substeps?: number;                                     // default: automatic
}
```

Each tick, every projectile goes through these steps:

1. **Expiry.** If `time >= expiresAt`, the projectile is deleted, then `onExpire` is called. It does not move this tick.
2. **Sub-steps.** Unless `substeps` is given, the tick is split automatically so that one sub-step moves the projectile at most about one radius: `ceil(speed * dt / max(0.05, radius))`, clamped to 1..16. The speed is measured at the start of the tick. This keeps fast projectiles from tunnelling through thin targets.
3. **In each sub-step:** velocity += (`gravity` + `accelerate(p)`) · dt, then position += velocity · dt. Then `hit(p)` is asked first. Only if it returns nothing is `solid(point)` asked.
4. **Impact.** On a hit or a solid contact, `onImpact(p, target, point)` is called. `target` is `undefined` for a solid contact. Unless it returns `true`, the projectile is deleted and its remaining sub-steps are skipped. If there is no `onImpact`, the projectile is simply deleted.

Some details:

- The list of projectiles is taken at the start of the call. Projectiles that callbacks delete are skipped. Projectiles that callbacks add (cluster bombs) are first stepped next tick.
- A target with a string or number `id` is hit at most once per projectile. When `onImpact` returns `true` (piercing, bouncing), the hit is recorded in `p.data['gaime-hit:<id>'] = true`, and later sub-steps and ticks treat that target as no hit (then `solid` is asked). `wasHit(projectile, id)` reads that record, for example to skip already hit targets in your `hit` callback so the next one behind can be found. Targets without an `id` are not tracked: remember them yourself in `p.data`.
- For a side view, pass `gravity: { x: 0, z: -g }`, or return it from `accelerate` when it depends on the projectile.

### `wasHit(projectile, id): boolean`

True when a kept-alive (piercing, bouncing) projectile has already hit the target with this `id` (string or number).

```ts
// A piercing shot: skip enemies it already went through, so the next one behind can be hit.
hit: p => Object.values(world.enemies).find(e => !wasHit(p, e.id) && Math.hypot(e.x - p.x, e.z - p.z) < ENEMY_RADIUS + p.radius),
onImpact: (p, enemy) => { if (enemy) enemy.hp -= 10; return p.data.pierce !== false; },
```

### `ballisticAngle(from, target, speed, g): number | null`

This returns the launch angle that makes a ballistic shot with `speed` land on `target`, under gravity of magnitude `g` pointing to -Z. The angle is **in radians from +X towards +Z** (an elevation angle). It returns the low arc, or `null` when the target is out of range. Shots to the left (`target.x < from.x`) return `Math.PI - elevation`. Wind and other accelerations are not taken into account. It is handy for bots and aim assist in side-view games.

```ts
// A side-view artillery game (games/duel): kit angles are from +Z ("up"), elevation from +X.
const elevation = ballisticAngle(muzzle, { x: enemy.x, z: enemy.z + 0.8 }, speed, RULES.gravity);
if (elevation !== null) {
  const id = `s${ctx.nextId()}`;
  world.projectiles[id] = launch({ id, kind: 'shell', owner: bot.id, from: muzzle, angle: Math.PI / 2 - elevation, speed, radius: 0.25, life: 12, time: world.time });
}

stepProjectiles(world.projectiles, {
  dt, time: world.time,
  accelerate: p => ({ x: world.wind, z: -RULES.gravity }),
  hit: p => fighters(world).find(f => f.hp > 0 && f.id !== p.owner && Math.hypot(f.x - p.x, f.z + 0.8 - p.z) < RULES.playerRadius + p.radius),
  solid: point => point.z <= heightAt(world.terrain, point.x),
  onImpact: (p, _target, at) => explode(at, defs[p.kind].radius, defs[p.kind].damage, p.owner),
});
```

---

## Timers

These are time-based helpers that store their state in plain records, so they survive checkpoints and hot reloads. `time` is always `world.time`. All the keys you use share one record, so prefix them with your feature id when several features write into the same `data` bag.

| Helper | Store type |
| --- | --- |
| `cooldown.*` | `Record<string, number \| string \| boolean>` (for example `player.cooldowns` or `player.data`) |
| `every`, `schedule`, `due`, `status.*` | `Record<string, number \| string \| boolean>` (for example `player.data`, `entity.data`) |

### Kit timers or engine timers?

The engine has its own time-based mechanisms ([SIMULATION.md](SIMULATION.md)). They do different jobs:

| You need… | Use | Why |
| --- | --- | --- |
| a duration you **read on demand** — "is this player stunned / shielded / slowed?", "is the dash ready?" | kit `status` / `cooldown` in `entity.data` / `player.cooldowns` | costs nothing until somebody asks; synchronised, so the client can draw it |
| something that must **happen** once, later — a fuse, a respawn, a pickup expiring, a delayed reward | an engine timer: `ctx.after(3, 'bomb.explode', { bomb: id }, { key: `bomb:${id}` })` | fires an event other modules can react to; one heap for the whole game instead of a check per entity per tick; cancellable by key |
| a repeating game-wide rhythm with an event — a storm pulse every 10 s, a burn that ticks 5 times | `ctx.every(seconds, event, data, { key, times? })` | same, recurring |
| periodic **work** — a spawner, regeneration, AI thinking at 5 Hz | a system with `every: seconds` | the engine staggers periodic systems across ticks, measures them in `/gaime/stats` → `parts`, and isolates module errors |
| a simple per-entity rhythm inside code that already runs every tick (an enemy that slams every 6 s) | kit `every(entity.data, 'slam', time, 6)` or `schedule`/`due` | fine for simple cases; no event needed |

Rule of thumb: kit helpers are **state you read**, engine timers are **events that fire**, systems are **work that runs**. The kit `every` is still fine for small, local cases; for game-level periodic work, a system with `every` is the preferred engine-level way.

### `cooldown`

The store holds one value per key: the time at which the cooldown is ready again. A missing key counts as ready.

```ts
cooldown.ready(store, key, time): boolean                   // store[key] <= time
cooldown.start(store, key, time, seconds): void             // store[key] = time + seconds (unconditionally)
cooldown.use(store, key, time, seconds): boolean            // if ready: start it and return true; else false
cooldown.remaining(store, key, time): number                // seconds left, >= 0
```

```ts
if (!cooldown.use(player.cooldowns, 'dash', world.time, 4)) {
  return `Dash ready in ${cooldown.remaining(player.cooldowns, 'dash', world.time).toFixed(1)} s.`;
}
```

### `every(store, key, time, interval, immediately = false): boolean`

This returns true once every `interval` seconds. Call it every tick.

- **First call:** it schedules the next firing at `time + interval` and returns `immediately` (false by default). A timer therefore first fires one interval after it was first checked.
- **Normal ticks:** after firing, the next firing is `next + interval`. The phase stays stable even when ticks do not line up with the interval.
- **Missed intervals are skipped, not replayed.** After a gap longer than one interval (a pause, a long stall), it fires once, and the next firing is a full interval later (`time + interval`). There is no burst of catch-up firings.
- The key holds the next firing time. `delete store[key]` resets the timer.

```ts
// an enemy that slams every 6 s, inside an enemy system that already runs every tick
if (every(enemy.data, 'ola-slam', world.time, 6)) slam(sim, enemy);
```

For a game-wide spawner prefer a system: `systems: [{ id: 'spawn', every: RULES.spawnEvery, run: spawn }]` (this is what `games/blank/src/server/game.ts` does).

### `schedule(store, key, time, delay)` and `due(store, key, time): boolean`

`schedule` records that something should happen at `time + delay`, overwriting any earlier schedule for that key. `due` returns true **exactly once** when that moment has passed, and deletes the key. It returns false when nothing is scheduled.

```ts
schedule(enemy.data, 'bomber-fuse', world.time, 1.5);   // when the bomber reaches the crystal
// … later, every tick:
if (due(enemy.data, 'bomber-fuse', world.time)) explode(enemy);
```

### `status`

`status` tracks an active effect with an end time (buffs, slows, stuns). For a key `k`, it stores the value under `k` and the end time under **`k:until`**.

```ts
status.apply(store, key, time, seconds, value: number | boolean = true): void
status.active(store, key, time): boolean                         // Number(store[`${key}:until`] ?? 0) > time
status.value<V extends number | boolean>(store, key, time, fallback: V): V   // store[key] while active, else fallback
status.clear(store, key): void                                   // deletes key and key:until
```

- `apply` **extends, never shortens**. The end time becomes `max(current end, time + seconds)`. The **value is always replaced** by the new one. To make "the strongest effect wins", compute the value yourself (see the aura recipe below).
- Expired statuses are not removed. Their two keys stay in the store (and in the checkpoint) until you call `status.clear` or apply the status again.

```ts
// games/tag: a speed pickup, and movement that reads it
status.apply(player.data, 'speed', world.time, 4, 1.6);
const speed = RULES.speed * status.value(player.data, 'speed', world.time, 1);
```

---

## Match lifecycle

This is the round lifecycle shared by most session games:

```
lobby ──(enough players ready)──▶ countdown ──▶ playing ──(endMatch / duration)──▶ ended ──(toLobby / resultSeconds)──▶ lobby
```

```ts
type MatchPhase = 'lobby' | 'countdown' | 'playing' | 'ended';

interface MatchState {
  phase: MatchPhase;
  round: number;                   // incremented on every start
  ready: Record<string, boolean>;  // player id → ready
  until: number;                   // countdown end (countdown) or round end (playing, with a duration)
  startedAt: number;
  endedAt: number;
  winner: string | null;           // winner id, team, or null for a draw
  reason: string;                  // e.g. 'time', 'last standing'
}

interface MatchRules {
  minPlayers?: number;     // players needed to start, default 1
  countdown?: number;      // seconds from "everyone is ready" to the start, default 3 (0 = immediately)
  duration?: number;       // round length; the round ends with reason 'time'. Default: no limit
  autoStart?: boolean;     // start as soon as minPlayers are present, no ready clicks. Default false
  resultSeconds?: number;  // seconds in 'ended' before returning to the lobby by itself. Default: stay
}

type MatchEvent = 'countdown' | 'cancelled' | 'start' | 'timeout' | 'lobby' | undefined;
```

Keep `match` in your `World` (`match: createMatch()`) and call `stepMatch` every tick with the **same rules every time**.

| Function | Behaviour |
| --- | --- |
| `createMatch(): MatchState` | A fresh state in `lobby`, round 0. |
| `setReady(match, playerId, ready = true)` | Marks or unmarks a player as ready. It works in `lobby`, `countdown` and `ended`, and is ignored while `playing`. |
| `stepMatch(match, time, present, rules = {}): MatchEvent` | Advances the lifecycle and returns what happened this tick, so the game can react exactly once. `present` is the list of ids that take part (online, not spectators). |
| `endMatch(match, time, winner, reason = '')` | Moves `playing` to `ended` and records `winner`, `reason` and `endedAt`. It does nothing in any other phase. |
| `toLobby(match)` | Sets the phase to `lobby` and **clears `ready`**. Works from any phase. |
| `matchTimeLeft(match, time): number` | `max(0, until - time)` in `countdown` and in `playing` with a duration. `0` otherwise (`lobby`, `ended`, a round without a limit). |

What `stepMatch` does on each call:

1. It removes ready flags of ids that are not in `present`. "All ready" means `present.length >= minPlayers` and either `autoStart` is set or every present id is ready.
2. `lobby` and all ready: with `countdown > 0`, it enters `countdown` and returns `'countdown'`. Otherwise it starts right away and returns `'start'`.
3. `countdown`: if not everyone is ready any more, it goes back to `lobby` and returns `'cancelled'`. When `time >= until`, it starts and returns `'start'`.
4. Start: phase `playing`, `round++`, `startedAt = time`, `until = time + duration` (or 0), winner and reason reset, `ready` cleared.
5. `playing` with a `duration`: when `time >= until`, it calls `endMatch(match, time, null, 'time')` and returns `'timeout'`.
6. `ended` with `resultSeconds`: when `time >= endedAt + resultSeconds`, it calls `toLobby` and returns `'lobby'`.

Notes:

- The game decides when a round is won. Call `endMatch` from `step`.
- In `ended`, ready flags have no effect until the phase is `lobby` again. For "click ready to rematch", call `toLobby` before `setReady`, as `games/duel` does:

  ```ts
  case 'ready':
    if (world.match.phase === 'ended') toLobby(world.match);
    setReady(world.match, playerId, !world.match.ready[playerId]);
    return;
  ```

- `until` is not reset by `endMatch`, `toLobby` or a cancelled countdown, so do not read it directly outside `countdown` and `playing`. `matchTimeLeft` already returns 0 there.

```ts
// games/duel/src/server/simulation.ts
const seated = fighters(world).filter(p => p.online).map(p => p.id);
const event = stepMatch(world.match, world.time, seated, { minPlayers: 2, countdown: 3 });
if (event === 'start') startRound(world, registry, ctx);
if (event === 'countdown') ctx.emit('sound', { kind: 'tick' });
```

---

## Turns

This is turn order for turn-based games (artillery, board and card games). Keep it as plain data in the `World`.

```ts
interface TurnState {
  order: string[];        // player (or team) ids in play order
  index: number;          // index of the current id in `order`
  turn: number;           // 1-based count of turns played
  endsAt: number;         // world time when the current turn times out (0 = no limit)
  frozen: number | null;  // seconds left while the clock is stopped
}
```

| Function | Behaviour |
| --- | --- |
| `createTurns(order, time, seconds, first = 0): TurnState` | Copies `order` and starts at index `first` (clamped). `turn = 1`. `endsAt = time + seconds`, or 0 when `seconds` is 0. |
| `currentTurn(turns): string \| undefined` | The id whose turn it is (also while frozen). |
| `isTurnOf(turns, id): boolean` | True when it is `id`'s turn **and the clock is not frozen**. Use it to reject a second action while a shot resolves. |
| `turnTimeLeft(turns, time): number` | The frozen value while frozen. Otherwise `max(0, endsAt - time)`, or `Infinity` with no limit. |
| `turnExpired(turns, time): boolean` | True when there is a limit, the clock is not frozen, and `time >= endsAt`. |
| `nextTurn(turns, time, seconds, canPlay = () => true): string \| undefined` | Passes the turn to the next id in order for which `canPlay` is true, wrapping around. The current id comes last, so a sole survivor gets another turn. It sets `turn++`, a new `endsAt` and unfreezes the clock. Returns the new id, or `undefined` when nobody can play: the current turn goes on and a frozen clock is resumed (`resumeTurn`), so it never stays stuck frozen. |
| `freezeTurn(turns, time)` | Stops the clock, for example while a projectile flies. It stores the seconds left (0 for an unlimited turn). It does nothing if already frozen. |
| `resumeTurn(turns, time, atLeast = 0)` | Restarts the clock with `max(frozen, atLeast)` seconds left. An unlimited turn stays unlimited unless `atLeast > 0`. It does nothing if not frozen. |
| `syncTurns(turns, ids)` | Keeps `order` in sync with who is still in the game. It drops ids not in `ids`, appends new ids at the end, and keeps the current player current. If the current player left, the turn passes to the next remaining player after them in the old order, wrapping around. The timer is not reset. |

```ts
// Fire: stop the clock until the shot resolves; afterwards give 3 s to retreat.
if (!isTurnOf(world.turns, playerId)) return 'Not your turn.';
fire(world, player);
freezeTurn(world.turns, world.time);
// … in step, once no projectile is left:
resumeTurn(world.turns, world.time, 3);
// … and when the time is up:
if (turnExpired(world.turns, world.time)) nextTurn(world.turns, world.time, 30, id => (world.players[id]?.hp ?? 0) > 0);
```

---

## Inventory

An inventory holds counted items (ammo, potions, resources, cards in hand) as `Inventory = Record<itemId, count>` inside a player or entity. It is plain data and checkpoint friendly. Items whose count reaches 0 are deleted from the record.

| Function | Returns | Behaviour |
| --- | --- | --- |
| `itemCount(inventory, id)` | `number` | 0 when absent. |
| `hasItem(inventory, id, count = 1)` | `boolean` | `itemCount >= count`. |
| `addItem(inventory, id, count = 1, max = Infinity)` | `number` | Adds up to a per-item `max`, and returns how many were actually added. A `count` ≤ 0 (or NaN) adds nothing and returns 0, and a count already above `max` is never reduced. |
| `takeItem(inventory, id, count = 1)` | `boolean` | Removes `count` only if all of them are there. Otherwise it changes nothing and returns false. |
| `transferItem(from, to, id, count = 1, max = Infinity)` | `number` | Moves up to `count`, limited by what `from` has and by the room left under `max` in `to`. Returns how many moved (trades, loot). |

```ts
if (!takeItem(player.ammo, 'grenade')) return 'No grenades left.';
const looted = transferItem(chest.items, player.items, 'gold', 50, 999);
ctx.notify(player.id, `+${looted} gold`);
```

---

## Random

Every function takes a `random: () => number` returning a value in [0, 1). Pass `ctx.random` on the server, or `seeded(n)` in tests.

| Function | Returns |
| --- | --- |
| `range(random, min, max)` | A float in [min, max). |
| `int(random, min, max)` | An integer in [min, max], **both inclusive** (for integer bounds). |
| `chance(random, probability)` | `random() < probability`. |
| `pick(random, items)` | A uniform element, or `undefined` for an empty list. |
| `weighted(random, items, weightOf)` | A weighted choice. Items with weight ≤ 0 are never picked. Returns `undefined` when the total weight is ≤ 0. |
| `shuffle(random, items)` | A **new** shuffled array (Fisher–Yates). The input is untouched. |
| `pointInRing(random, center, inner, outer)` | A point uniformly distributed over the ring area between the two radii (spawn points). |
| `pointOnCircle(random, center, radius)` | A point on the circle (arena edge spawns). |

```ts
const wave = weighted(ctx.random, eligibleWaves, w => w.weight ?? 1) ?? eligibleWaves[0];
const at = pointOnCircle(ctx.random, { x: 0, z: 0 }, RULES.arenaRadius - 1.5);
```

---

## Teams and colours

Teams are plain ids stored on players.

```ts
const TEAM_COLORS = ['#ff5977', '#59a8ff', '#7dff9b', '#ffd659', '#b481ff', '#59ffe0'];

balancedTeam(teams: readonly string[], current: Iterable<string | undefined>): string
paletteColor(index: number, palette = TEAM_COLORS): string
freeColor(used: Iterable<string>, palette = TEAM_COLORS): string
```

- `balancedTeam` returns the smallest team among `teams` for a newcomer. On a tie, the team listed first wins. `current` is the team of every existing player. `undefined` and unknown ids are ignored. An empty `teams` throws `balancedTeam: pass at least one team id.`
- `paletteColor` returns the colour for the n-th player or team, cycling through the palette. Negative indices wrap too.
- `freeColor` returns the first palette colour not in `used`. When all are taken, it returns `paletteColor(number of distinct used colours)`.

```ts
createPlayer(world, id, name) {
  const team = balancedTeam(['red', 'blue'], Object.values(world.players).map(p => p.team));
  return { id, name, online: true, data: {}, team, color: freeColor(Object.values(world.players).map(p => p.color)), /* … */ };
}
```

---

## Effects

Effects are short-lived visual events (tracers, explosions, floating text). They are kept in a world array and synchronised as a stream (`network.streams: ['feed', 'effects']`). Once emitted they are immutable, and the client animates them by age (`renderTime - effect.time`). `EffectsLayer` in `@gaime/core/three` draws the built-in types.

```ts
type EffectType = 'tracer' | 'pulse' | 'hit' | 'spawn' | 'text' | 'explosion' | (string & {});

interface Effect {
  id: number; type: EffectType; time: number; x: number; z: number;
  y?: number;              // height above the ground (default depends on the type)
  x2?: number; z2?: number;  // end point for tracers / beams
  radius?: number; color?: string; text?: string;
}

addEffect(list, id, type, time, at, options?): Effect   // pushes and returns the effect; id from ctx.nextId()
pruneEffects(list, time, life = 1.5): Effect[]          // NEW array without effects aged >= life
```

`pruneEffects` does not mutate the list, so assign its result. Call it once per tick.

```ts
world.effects = pruneEffects(world.effects, world.time, 2);
addEffect(world.effects, ctx.nextId(), 'explosion', world.time, at, { radius, color: '#ff8a3d' });
addEffect(world.effects, ctx.nextId(), 'text', world.time, player, { text: `-${damage}`, color: '#ff5977', y: 3 });
```

---

## Movement: `moveTopDown`

```ts
interface MoveInput { mx: number; mz: number }   // direction per axis, -1..1

moveTopDown(entity: { x: number; z: number; vx?: number; vz?: number }, input: MoveInput, speed: number, dt: number, acceleration?: number): void
```

This is top-down movement on the x/z plane. Run the same function on the server (authority) and on the client (prediction of your own character) so both agree.

- Each axis is clamped to [-1, 1], and non-finite values count as 0. A vector longer than 1 (a keyboard diagonal) is normalised, so diagonals are not faster.
- Without `acceleration`, movement is instant: position += direction · speed · dt (arcade feel).
- With `acceleration`, `vx` and `vz` each move towards `direction * speed` by at most `acceleration * dt` per axis (written onto the entity), then position += velocity · dt. Movement eases in and out.

```ts
// games/starter/src/shared/rules.ts: shared by the server and client prediction
export function movePlayer(player: Player, input: Input, dt: number) {
  moveTopDown(player, input, RULES.playerSpeed, dt);
  clampToArena(player);
}
```

---

## Helpers in `@gaime/core`

These live in the root package (`packages/core/src/shared/math.ts`, `world.ts`), next to the `Vec2` type.

| Helper | Behaviour |
| --- | --- |
| `clamp(value, min, max)` | Clamps a value to [min, max]. |
| `lerp(a, b, t)` | `a + (b - a) * t`. |
| `dist(a, b)`, `dist2(a, b)` | Distance and squared distance on x/z. |
| `angleTo(from, to)` | `atan2(dx, dz)`: the angle from +Z, matching Three.js `rotation.y`. |
| `wrapAngle(angle)` | Normalises an angle to (-π, π]. |
| `approach(value, target, step)` | Moves `value` towards `target` by at most `step`. |
| `damp(lambda, dt)` | Frame-rate independent smoothing factor `1 - exp(-lambda * dt)`, for `lerp(current, target, damp(10, dt))`. |
| `nearest(from, items, range = Infinity, filter?)` | Nearest item within `range` (inclusive), or `undefined`. A linear scan. |
| `seeded(seed)` | A deterministic PRNG (mulberry32) returning `() => number` in [0, 1). |
| `baseWorld(schema)` | The engine-owned fields of a new world: `{ schema, version: 'LOCAL', time: 0, pause: null, hostId: null, players: {}, feed: [], seq: 0 }`. Spread it into `createWorld()`. |
| `nextId(world)` | Increments and returns `world.seq`. The same as `ctx.nextId()`. |
| `pushFeed(world, text, from?, kind?)` | Appends a feed item (text cut to 280 characters) and keeps the last 40 (`FEED_LIMIT`). `ctx.log` uses it. |
| `findPlayer(players, query)` | Lookup by exact id, then by case-insensitive exact name, then by a unique name prefix. |
| `hydrate(saved, defaults, playerTemplate?)` | Fills fields missing from an older checkpoint: top-level keys from `defaults`, player fields from `playerTemplate`, plus `players`, `feed` and `player.data` when absent. Existing values are never overwritten. The engine calls it before `migrate`. |

---

## Recipes

### An ability with a cooldown

The cooldown lives in `player.cooldowns` (a `Record<string, number>` on the player), so it survives reloads and the client can draw it from the synchronised world.

```ts
// server: GameDefinition.command
case 'dash': {
  if (player.respawnAt) return;
  if (!cooldown.use(player.cooldowns, 'dash', world.time, 4)) return;     // silently ignore spam
  const target = { x: command.x, z: command.z };
  const from = { x: player.x, z: player.z };
  const d = dist(player, target) || 1;
  const length = Math.min(6, d);
  player.x += ((target.x - player.x) / d) * length;
  player.z += ((target.z - player.z) / d) * length;
  clampToArena(player);
  addEffect(world.effects, ctx.nextId(), 'tracer', world.time, from, { x2: player.x, z2: player.z, color: '#59e3ff' });
  return;
}

// client HUD: the same world data
const left = cooldown.remaining(me.cooldowns, 'dash', world.time);
button.textContent = left > 0 ? left.toFixed(1) : 'Q';
```

### A slowing aura with `status`

Players with the frost upgrade slow every enemy within 5 m. The aura refreshes a short status every tick, so the slow ends 0.5 s after an enemy leaves the aura. The strongest slow wins, because `status.apply` always replaces the value.

```ts
function slow(enemy: Enemy, factor: number, seconds: number, time: number) {
  const current = status.value(enemy.data, 'slow', time, 1);
  status.apply(enemy.data, 'slow', time, seconds, Math.min(current, factor));
}

// in step
const grid = new SpatialHash<Enemy>(5).rebuild(Object.values(world.enemies));
for (const player of Object.values(world.players)) {
  if (!player.online || !player.data['frost-aura']) continue;
  for (const enemy of grid.query(player, 5)) slow(enemy, 0.5, 0.5, world.time);
}
for (const enemy of Object.values(world.enemies)) {
  const speed = defs[enemy.kind].speed * status.value(enemy.data, 'slow', world.time, 1);
  moveTowards(enemy, { x: 0, z: 0 }, speed * dt);
}
```

### A turn-based round with `match` and `turns`

The match handles lobby, countdown and results. `turns` handles whose move it is inside a round.

```ts
interface World extends BaseWorld<Player> { match: MatchState; turns: TurnState | null; /* board… */ }

const RULES: MatchRules = { minPlayers: 2, countdown: 3, resultSeconds: 8 };
const TURN_SECONDS = 20;

function step(world: World, inputs: Readonly<Record<string, Input>>, dt: number, ctx: GameContext<World>) {
  const present = Object.values(world.players).filter(p => p.online && !p.spectator).map(p => p.id);
  const event = stepMatch(world.match, world.time, present, RULES);
  if (event === 'start') {
    resetBoard(world);
    world.turns = createTurns(shuffle(ctx.random, present), world.time, TURN_SECONDS);
    ctx.log(`Round ${world.match.round} begins.`);
  }
  if (event === 'lobby') world.turns = null;
  if (world.match.phase !== 'playing' || !world.turns) return;

  syncTurns(world.turns, present);                      // players who left mid-round
  if (world.turns.order.length < 2) {
    endMatch(world.match, world.time, world.turns.order[0] ?? null, 'forfeit');
    return;
  }
  if (turnExpired(world.turns, world.time)) {
    ctx.log(`${world.players[currentTurn(world.turns)!].name} ran out of time.`);
    nextTurn(world.turns, world.time, TURN_SECONDS);
  }
}

function command(world: World, playerId: string, command: Command, ctx: GameContext<World>) {
  if (command.type === 'ready') { if (world.match.phase === 'ended') toLobby(world.match); setReady(world.match, playerId); return; }
  if (command.type === 'move') {
    if (world.match.phase !== 'playing' || !world.turns || !isTurnOf(world.turns, playerId)) return 'Not your turn.';
    if (!applyMove(world, playerId, command)) return 'Illegal move.';
    const winner = findWinner(world);
    if (winner) { endMatch(world.match, world.time, winner, 'four in a row'); return; }
    nextTurn(world.turns, world.time, TURN_SECONDS);
  }
}
```

### Periodic spawns at the arena edge

A spawner is periodic work, so it is a system with `every` (the engine staggers it and measures it); the kit chooses and places. `ctx` here is the `GameContext` (a system receives it when the game defines no `Sim`; with a `Sim`, use its equivalents).

```ts
// defineGame({ systems: [{ id: 'spawn', every: 2.5, run: ctx => spawnAtEdge(ctx, registry) }, { id: 'separate', run: ctx => separateEnemies(ctx, registry) }] })
function spawnAtEdge(ctx: GameContext<World>, registry: Registry) {
  const world = ctx.world;
  if (world.phase !== 'fight') return;
  const def = weighted(ctx.random, registry.lists.enemies, e => e.weight ?? 1);
  if (!def) return;
  const at = pointOnCircle(ctx.random, { x: 0, z: 0 }, RULES.arenaRadius - 1.5);
  const id = `e${ctx.nextId()}`;
  world.enemies[id] = { id, kind: def.id, ...at, angle: angleTo(at, { x: 0, z: 0 }), hp: def.hp, maxHp: def.hp, data: {} };
  addEffect(world.effects, ctx.nextId(), 'spawn', world.time, at, { radius: def.radius, color: def.visual.color });
}

function separateEnemies(ctx: GameContext<World>, registry: Registry) {
  separate(Object.values(ctx.world.enemies), e => registry.kinds.enemies[e.kind]?.radius ?? 0.5);
}
```
