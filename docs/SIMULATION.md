# The simulation model

Every gaime game runs on the same engine (`packages/core/src/server/engine.ts`). Games and modules plug into five mechanisms: one **clock**, an **event bus**, **modifiers**, **timers** and **systems**. Using them — instead of ad-hoc loops, flags and cross-module calls — is what keeps a game consistent when many people add features to it, and what keeps it fast and alive under load.

```text
                    ┌────────────────────────── one tick (1 / tickRate s) ─────────────────────────┐
 inputs, commands → │ jobs → clock (time, tick) → due timers → input systems → step → update → late │ → patch + events
                    └──────────────── every triggered event is dispatched after the code that raised it ┘
```

## Where things go

| You need… | Use | Not |
| --- | --- | --- |
| something that happens every tick (movement, collisions, AI) | a **system** (or `step` for input handling) | a loop inside another module's hook |
| something periodic (spawner, regeneration, AI thinking at 5 Hz) | a system with `every: seconds` | checking `world.time % n` |
| something later, once (explosion in 3 s, respawn, a pickup expiring) | a **timer**: `ctx.after(3, 'bomb.explode', { id }, { key })` | `setTimeout`, a countdown field decremented per tick |
| a per-entity duration you read on demand (slow, stun, shield, cooldown) | kit `status` / `cooldown` in `entity.data` | a timer per frame |
| "when X happens, Y" across modules (kill → gold, pickup → combo) | **trigger** an event, **`on`** handlers react | calling another module's functions |
| a number several modules may adjust (damage, speed, price, points) | **`ctx.modify('player.damage', amount, data)`** + `modify` handlers | `if (hasArmor) …` scattered in the core |
| a new player action from a module | module **`commands`** | editing the game's `command` switch |
| a sound or effect on clients | forward the event (`network.events`) or `ctx.emit` | putting it into the world |
| "who is near X" (targets, separation, pickups in range) | the **spatial index**: `spatial` + `ctx.near` / `ctx.nearest` | looping over every entity for every entity |
| derived state that is not saved (a physics world, a nav grid, a cache) | **`ctx.resource(key, create)`** | a module-level variable |
| randomness | **`ctx.random()`** (the world's own generator) | `Math.random()` — breaks replays |
| heavy computation | a worker + `ctx.job` ([SERVER.md](SERVER.md#heavy-processing-workers)) | a long loop in a system |

## The clock

- `world.time` (seconds) and `world.tick` are the only clock. Every rule, timer, cooldown and status effect uses them; never `Date.now()`.
- The server runs a **fixed step**: each tick advances exactly `1 / tickRate` seconds (default 30 Hz). Tests (`testGame`) run the identical steps, so results match the server.
- A slow tick is caught up (up to 3 ticks at once); beyond that the game slows down instead of spiralling. Dropped time is reported as `droppedMs` in `/gaime/stats`.
- While paused (`world.pause`), time stops: no timers fire, no systems run.
- `ctx.random()` draws from the world's own generator (`world.rng`, saved with the world). Together with the fixed step and timers in the world this makes the simulation **deterministic**: the same world and the same inputs give the same game — the basis for replays and for reproducible tests (`testGame(game, { seed })`).

## Events

Declare the game's events once, in `src/shared/types.ts`:

```ts
export type Events = {
  'enemy.died': { enemy: string; kind: string; by?: string; x: number; z: number };
  'wave.cleared': { wave: number };
};
```

Raise them anywhere with `ctx.trigger(name, data)` (or `sim.trigger`). React with `on` — in the game definition or in any module:

```ts
// src/features/ola-bounty/server.ts
export default {
  on: {
    'enemy.died': ({ by }, sim) => { if (by) sim.world.players[by].gold += 5; },
  },
} satisfies Feature;
```

Rules of the bus:

- **Deferred, same tick.** Handlers run right after the piece of code that triggered the event (a system, `step`, a command, a timer batch, a player joining) — never in the middle of it, so nobody's loop is disturbed. Nested work (a system that removes a player, a bot issuing a command) waits for the outermost piece. Events triggered by handlers run after that, in order (FIFO).
- **Deterministic order.** The game's handlers first, then modules in file order.
- **Payloads are plain JSON** (ids, numbers, strings). Pass ids, not objects: the entity may be gone by the time a handler runs — check.
- **Names**: `noun.verb` in the past tense for facts (`enemy.died`, `pickup.collected`).
- **Module-private events** are named `<module>:<event>` (`ola-bomb:fuse`) and need no entry in the game's `Events` — a module can schedule and handle its own events without editing shared files (payload type `any`: validate it). Everything other modules may react to belongs in `Events`.
- **Storm protection**: more than 50 000 events in one dispatch cycle (a handler re-triggering its own event) stops the loop and switches the offending module off.
- **To clients**: list events in `network.events` and clients receive them — batched, one `events` message per tick (`net.onEvent(name, …)`). Use it for sounds and effects; state belongs in the world.

### Engine events

The engine triggers these on every game's bus, so modules can react to players without hooks:

| Event | Payload | When |
| --- | --- | --- |
| `player.joined` | `{ player, bot }` | a new player or bot was created |
| `player.online` | `{ player }` | a connection came up (join, reconnect, a bot added) |
| `player.offline` | `{ player }` | a connection dropped (the character stays unless the game removes it) |
| `player.removed` | `{ player, name }` | the player is being deleted (kick, freed seat, `ctx.removePlayer`) |

A hot reload, deploy or restart marks every connected player offline **without** events for the second or two until their clients reconnect (then `player.online` fires). So never treat a player being momentarily `online: false` as leaving: react to `player.offline`, and if leaving matters (the "it" in Tag, a seat in a duel), give them a grace timer keyed `player:<id>:…` that `player.online` cancels.

## Modifiers

For values that many modules may want to change:

```ts
// the game
const damage = ctx.modify('player.damage', def.damage, { player: player.id, source: enemy.kind });
// a module
modify: { 'player.damage': (amount, { player }, sim) => status.active(sim.world.players[player].data, 'shield', sim.world.time) ? amount * 0.5 : amount },
```

Modifiers run synchronously in the same order as handlers; each gets the previous result. Returning `undefined` keeps the value; a throwing modifier is skipped (and its module switched off). Declare the names and their data next to `Events` in a `Modifiers` type and pass both to the types (`FeatureModule<Kinds, Sim, Events, Modifiers>`, `defineGame<World, Input, Sim, Events, Modifiers>`): a misspelled event or modifier name in a module is then a type error.

**Modifiers run on the server only.** Anything the client predicts (movement speed, collision sizes) must be computable on the client too: derive it in a shared function from world data (`speedOf(world, player)` reading a status in `player.data`) instead of a modifier — otherwise prediction and server disagree and the player rubber-bands. The Tag tutorial shows the pattern.

## Timers

```ts
ctx.after(3, 'bomb.explode', { bomb: id }, { key: `bomb:${id}` });     // once, in 3 s of game time
ctx.every(10, 'storm.pulse', {}, { key: 'storm' });                     // repeating (same key + event + interval = kept)
ctx.every(1, 'burn.tick', { enemy: id }, { key: `enemy:${id}:burn`, times: 5 });
ctx.cancel(`bomb:${id}`);                                                // one timer
ctx.cancel(`enemy:${id}:`, { prefix: true });                           // everything of one entity
ctx.timeLeft(`bomb:${id}`);                                              // seconds, or undefined
```

- Timers live in `world.schedule` (a heap, saved with the world, never sent to clients): they survive hot reloads, restarts and deploys, and cost O(log n) — thousands are fine.
- A due timer triggers its event; handlers do the work. So a timer is just "this event, later".
- **Keys**: give every timer that may need cancelling a key, prefixed by its owner (`bomb:<id>`, `enemy:<id>:burn`). Scheduling the same key again replaces the timer.
- Keys starting with `player:<id>:` are cancelled automatically when that player is removed. Cancel entity timers yourself when the entity dies (`ctx.cancel('enemy:<id>:', { prefix: true })`).
- At most 5 000 timers fire per tick; the rest fire on the next ticks, spreading a spike instead of freezing the game.

## Systems and `step`

```ts
systems: [
  { id: 'move-enemies', run: (sim, dt) => { /* every tick */ } },
  { id: 'think', every: 0.2, run: (sim, dt) => { /* 5 times per second, dt ≈ 0.2 */ } },
  { id: 'cleanup', phase: 'late', run: sim => { /* after everything else */ } },
],
```

- `step(world, inputs, dt, ctx, sim)` is where inputs are applied; it runs between the `input` and `update` phases.
- Phases: `input` → the game's `step` → `update` (default) → `late`. Within a phase: the game's systems, then modules' systems, in declaration order.
- `every` systems are **staggered**: two modules with `every: 1` do not run on the same tick, so periodic work spreads across ticks.
- Keep systems cheap and bounded: iterate what you need (the [spatial index](#spatial-index) for neighbours), not everything × everything. A module whose systems cost too much is throttled ([Module time budgets](#module-time-budgets)).
- `/gaime/stats` → `parts` lists the most expensive systems, handlers and commands (ms per second) — the first place to look when the tick gets slow.

## Module commands

A module can add player actions without touching the game's `command`:

```ts
commands: {
  'ola-teleport': (playerId, command, sim) => {
    const player = sim.world.players[playerId];
    if (!player || !Number.isFinite(command.x)) return 'Where to?';
    Object.assign(player, { x: command.x, z: command.z });
  },
},
```

Types are global — prefix them with the module id. Validate everything; a returned string goes back to the player. The client sends `net.command({ type: 'ola-teleport', x, z })`.

## The `Sim` facade

Handlers, systems and module commands receive what the game's `sim(ctx, dt)` builds — a `Sim` object with the world and the helpers modules are allowed to use (`hurtEnemy`, `spawn`, `trigger`, `after`, `modify`, `emit`…). Keep game rules in these helpers (damage → death → event) so every module goes through the same path. Without `sim`, they receive the `GameContext`.

## Isolation

Code owned by a module — its handlers, modifiers, systems, and definition hooks the game runs through `ctx.isolate(owner, …)` / `sim.isolate` — is isolated: an exception **switches that module off** (a ⚠ line in the feed, listed under `disabled` in `/health`), and the rest of the game keeps running. The next code load (a fix pushed) switches it back on. Errors in the game's own code still pause the game, as before. Commands are the exception to both: an error in any command handler (the game's or a module's) only becomes an error reply to that player — otherwise one malformed command from a player could switch a module off for everyone.

When the game calls a definition hook, wrap it:

```ts
const owner = registry.owner[`enemies/${def.id}`];
if (def.tick && sim.isolate(owner, () => { def.tick!(sim, enemy); return true; })) continue;
defaultAi(sim, enemy);    // disabled or failed module → the default behaviour
```

## Spatial index

```ts
defineGame({ spatial: { enemies: { cell: 4 }, players: { cell: 8 } }, … });

ctx.near<Enemy>('enemies', player, 6);                         // within 6 units, exact distance, current positions
ctx.nearest<Player>('players', enemy, 10, p => p.online);      // closest match (radius optional)
separateWith(enemies, radiusOf, e => ctx.near('enemies', e, 2 * MAX_RADIUS));   // crowds in O(n·k), from the kit
```

- Declare top-level `Record<id, { x, z }>` collections; the engine builds one grid per collection **at most once per tick, shared by every system and module** (its cost shows in `/gaime/stats` as `spatial <collection>`).
- Queries check the live entities: an entity moved earlier in the tick is found at its new place (within `margin`, default 1 unit), a deleted one is skipped. One created in this tick shows up from the next tick — or call `ctx.reindex(collection)`.
- `cell` ≈ your typical query radius. In `games/starter`, 800 enemies went from 10.6 to 2.2 ms per tick when AI targeting and crowd separation moved to the index.

## Resources

`ctx.resource(key, create, options?)` holds something derived from the world that must not be saved: a physics world ([PHYSICS.md](PHYSICS.md)), a navigation grid, a lookup table. It is created on first use, shared for the lifetime of the loaded code, and recreated from the world after a hot reload or restart — so `create` must rebuild it from world data. Never keep such things in module-level variables.

The third argument is either a `dispose(value)` function (runs when the code is replaced — free WebAssembly memory, close handles) or `ResourceOptions` `{ dispose?, save?, load? }`. `save(value)` returns JSON (or structured-clonable) state that is **not** in the world — a physics engine's contact cache, warm-starting and sleep state — and the flight recorder stores it with every segment snapshot; `load(data)` rebuilds the value from it when a replay starts (without `load`, `create` is used). A resource whose state is fully derivable from the world needs neither.

```ts
const nav = ctx.resource('ola-nav', () => buildNavGrid(ctx.world), grid => grid.free());
const phys = ctx.resource('my-physics', () => createEngine(ctx.world), {
  dispose: e => e.free(),
  save: e => e.snapshot(),                 // into flight recordings only — never into checkpoints
  load: data => restoreEngine(data),       // a replay starting mid-game continues from the exact state
});
```

## Module time budgets

Every module gets a slice of the tick (`GameDefinition.budget.moduleMs`, default 20% of the tick — 6.7 ms at 30 Hz). Once a second the engine compares each module's average cost per tick (its systems and handlers):

- over budget → its **systems** run only every 2nd tick (then 4th, 8th), staggered, with `dt` covering the skipped time; its event handlers and modifiers keep running, so no event is lost;
- well under budget again → back to every tick.

Both are announced in the feed (`⚡ Module "…" is over its time budget…`) and listed in `/gaime/stats` → `throttled`. One slow module then degrades itself instead of lagging the whole game. Game-owned systems are never throttled. Budgets are off in tests unless `testGame(game, { budget: true })`.

## Determinism and replays

The engine keeps a **flight recording** of the last minutes (`GameDefinition.record`, default on, 10 minutes): a world snapshot plus everything that entered the simulation from outside — input changes, commands, joins and leaves, bots, operator actions, request calls, worker results, throttling — stamped with ticks. `replay(game, recording)` rebuilds the session tick by tick with the current code and verifies world hashes every 5 s:

```ts
import { replay } from '@gaime/core/server';
const result = replay(game, JSON.parse(readFileSync('replay.json', 'utf8')));
expect(result.diverged).toBeUndefined();          // else: the first tick where the worlds differ
```

- **Where recordings come from**: saved automatically when the game pauses on an error or a module is switched off, on demand with `gaime replay`, and from tests: `testGame(game, { seed, record: true })` → `t.recording()`.
- **What breaks determinism**: `Math.random()`, `Date.now()`, module-level state, anything not driven by `world`, `ctx`, inputs and commands. A divergence report points at the first check (5 s window) where the worlds differ — bisect with `onTick`.
- **Segments**: the recording is kept as 3 segments of half the window each (so at least `minutes` are always covered), each starting with a world snapshot plus the engine state (system schedule, throttling, disabled modules, held inputs, and the `save` state of resources). A replay starts from the oldest segment's snapshot and checks each later snapshot on the way.
- **Resources**: state outside the world is replayed through `ResourceOptions.save` / `load` ([Resources](#resources)). `@gaime/physics` saves Rapier's snapshot this way, so a physics game replays **exactly** even when the recording starts in the middle of a round.
- **Limits**: replays need the same code version (a hot reload starts a new recording); code run through `engine.outside()` (and so `t.act` in tests) is not recorded — the recording is marked incomplete; custom `routes` that change the world are not recorded either (and not even marked), so change the world through commands, requests or admin commands. Worker results are replayed from the recording, not recomputed.

Every template has a test that records a session with bots and replays it byte for byte — keep one in your game: it catches non-determinism the day it is introduced.

## Load: what keeps a game standing

| Mechanism | Effect |
| --- | --- |
| fixed step + catch-up limit | a slow tick slows the game briefly instead of snowballing |
| staggered periodic systems | work spread over ticks, no every-second spikes |
| timer heap + per-tick limit | thousands of timers cost little; spikes spread over ticks |
| deferred FIFO bus + storm limit | no re-entrancy bugs, no infinite loops |
| module isolation | one broken feature does not stop the game |
| batched client events (256 per client per tick) | one message per tick instead of one per sound |
| delta patches, shared encoding, backpressure | [PROTOCOL.md](PROTOCOL.md) |
| per-part timing in `/gaime/stats` | you can see which module eats the tick |
| module time budgets | a slow module throttles its own systems instead of lagging everyone |
| shared spatial index | neighbour queries in O(k) for every module, one rebuild per tick |
| flight recorder | a crash or a weird bug under load can be replayed exactly, offline |

Measure with `npm run load -- <game> --bots 50` ([TESTING.md](TESTING.md#load-and-latency-gaime-load)).

## Testing

`testGame(game)` runs this exact engine without a network — join players, hold inputs, run seconds, send commands, inspect triggered events:

```ts
const t = testGame(game, { seed: 1 });      // or { random: seeded(1) } — but only `seed` runs can be recorded and replayed
const ada = t.join('Ada');
t.input(ada, { mx: 1, mz: 0 });
t.run(3);
expect(t.triggeredOf('pickup.collected')).toHaveLength(2);
```

`t.act(sim => …)` runs code against the `Sim` like a system would (its events are handled right after); `t.sim()` only reads. Module errors throw in tests (`strict`), so a broken module fails the test instead of being switched off. See [TESTING.md](TESTING.md).

## On the client

Events listed in `network.events` arrive batched per tick. Type the client with the game's events and subscribe by name:

```ts
const net = new GameClient<World, Input, Command, Events>({ game: 'blank' });
net.onEvent('pickup.collected', ({ playerId }) => { if (playerId === net.id) sounds.play('collect'); });
```

Module commands (`{ type: 'ola-teleport', … }`) are accepted by `net.command` without being part of the game's `Command` type.
