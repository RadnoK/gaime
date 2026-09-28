---
name: gaime-mechanic
description: Implement or change a core gameplay mechanic in a gaime game — new world state, simulation rules, events and modifiers, systems, timers, commands, player stats, rounds, scoring, physics — safely for live players and saved games (hydrate, migrations, HMR). Use for changes to a game's src/shared or src/server beyond adding a module.
---

# Change game mechanics safely

The game runs live while you edit it: every push is hot-reloaded into a running room that keeps its world. Your change must work on the **existing** world, not only on a fresh one. Read `docs/SIMULATION.md` first — the core of a game is written against its clock, events, modifiers, timers and systems.

## 1. Design the bus first

Before writing rules, decide in `src/shared/types.ts`:

- **`Events`** — the facts of the mechanic others may react to, past tense, ids in the payload: `'enemy.died': { enemy: string; kind: string; by?: string; x: number; z: number }`. Trigger each in exactly one place (a `Sim` helper), so every path goes through it.
- **`Modifiers`** — the numbers others may adjust, with the data passed along: `'player.damage': { player: string; source: string }`. Compute them with `sim.modify(name, base, data)` wherever the value is used. Modifiers run on the server only: a value the client predicts (movement speed, collision size) must come from a shared function in `rules.ts` reading world data instead.
- **`Sim`** — the helpers module code may call (`hurtEnemy`, `spawn`, `trigger`, `after`, `modify`, `emit`, `isolate`…), built by `makeSim` in `simulation.ts`.

Comment every entry — this is the API other people's modules are written against — and pass the maps to `defineGame<World, Input, Sim, Events, Modifiers>` and `FeatureModule<Kinds, Sim, Events, Modifiers>` so names are type-checked. Existing names are stable: renaming an event breaks modules and pending timers. Player lifecycle needs no events of your own: the engine triggers `player.joined`, `player.online`, `player.offline`, `player.removed`. Modules name their private events `<module>:<event>` without touching `Events`.

## 2. Where the change goes

| Change | Where |
| --- | --- |
| New/changed world or player fields | `src/shared/types.ts` + defaults in `createWorld()` / `createPlayer()` |
| Rules shared with client prediction (movement, geometry) | `src/shared/rules.ts` |
| Applying inputs (movement, aim) | `step(world, inputs, dt, ctx, sim)` in `simulation.ts` (optional; runs between `input` and `update` systems) |
| Per-tick rules (collisions, AI, projectiles) | a system in `defineGame({ systems })`: `{ id: 'collide', run: sim => … }`; `phase: 'late'` for cleanup/clamping after everything |
| Periodic work (spawners, regeneration, AI thinking) | a system with `every: seconds` — not `world.time % n` or a per-tick counter |
| Something once, later (respawn, fuse, expiry, round end) | a timer: `ctx.after(seconds, 'event', data, { key: '<owner>:<id>' })` + an `on` handler; cancel it when the owner goes away (`ctx.cancel(prefix, { prefix: true })`) |
| Reactions to a fact (score on kill, open a door on round end) | `on` in `defineGame` (the game's handlers run first), or in a module |
| A player action | a `Command` variant + `command()`; the client sends `net.command({...})` (module actions: module `commands`) |
| Continuous control (movement, aim) | `Input` + `parseInput` in `game.ts` |
| Something modules should be able to do | a method on `Sim`; when it calls a definition hook, wrap it in `ctx.isolate(registry.owner['<kind>/<id>'], …)` |
| Query from the client (ranking, shop list) | `requests` in `defineGame` → `net.request(name)` |
| One-off client feedback (sound, shake) | forward the event (`network.events: ['enemy.died']`) or `ctx.emit(name, data)` → `net.on('event', …)` |
| Neighbour queries (targeting, crowd separation, pickups in range) | the engine's spatial index: `spatial: { enemies: { cell: 4 } }` in `defineGame` + `ctx.near('enemies', at, r)` / `ctx.nearest(...)`, exposed to modules through `Sim` helpers (`nearestEnemy`); crowds with kit `separateWith(items, radiusOf, e => ctx.near(...))` |
| Derived state that is not saved (physics world, navigation grid, lookup cache) | `ctx.resource('<owner>-<name>', () => build(ctx.world), dispose)` — rebuilt from the world after a hot reload; add `{ save, load }` if it holds state the world does not (so replays stay exact) |
| Rounds / sessions for a few players at a time | consider `rooms: { mode: 'matches', size }` (many rooms, invite codes) and `ctx.lockRoom(true)` while a round runs — `docs/ROOMS.md` |

Timed state that code *reads* (stun, shield, cooldown) stays in the kit (`status`, `cooldown` in `data`); timers are for things that must *happen*.

## 3. State rules

- JSON only; ids as `Record<string, T>` keys; times as `world.time` values (`respawnAt`, `nextShotAt`).
- New fields: add them to `createWorld()`/`createPlayer()` — older saves and the hot-reloaded world get the defaults automatically (`hydrate`). No migration needed.
- Changed meaning/type of an existing field, renamed field, restructured data: bump `SCHEMA` in `simulation.ts` and migrate in `defineGame({ migrate })`:

  ```ts
  migrate(world) {
    if (world.schema < 2) {
      for (const p of Object.values(world.players)) p.gold = (p as any).coins ?? 0;   // coins → gold
      world.schema = 2;
    }
    return world;
  },
  ```

  Throwing in `migrate` keeps the old save untouched and pauses the game with the error — use it only when the save really cannot be used.
- Timers live in `world.schedule` (saved, hidden from clients) with their event name and payload. Renaming an event or changing its payload: keep a handler for the old form until pending timers fire, or cancel them in `migrate` (`cancelTimers(world.schedule, prefix)` from `@gaime/core`). The engine fills `tick`/`schedule` on older saves by itself.
- Server-only helper state that clients do not need: list the key in `network.hidden`.
- Big dictionaries that change often: list them in `network.entities`.

## 4. Keep it deterministic

The engine records every session and `replay()` must reproduce it exactly (docs/SIMULATION.md#determinism-and-replays) — that is how live bugs get fixed. So:

- randomness only from `ctx.random()` / `sim.random()` (the world's generator, `world.rng`); pass it to kit helpers (`weighted(ctx.random, …)`); never `Math.random()`;
- no `Date.now()`/`performance.now()` in rules, no state outside the world except `ctx.resource` values rebuilt from it;
- iterate the world's own records, not sets built from async results;
- keep the game's record-and-replay test green (`testGame(game, { seed, record: true })` → `replay(game, t.recording())`, see `gaime-test`).

## 5. Use the kit instead of re-inventing

`@gaime/core/kit` (docs/KIT.md): `moveTopDown`, `clampToCircle`/`clampToRect`/`keepOutOfCircle`, `raycast`/`rayEnd`, `circlesOverlap`, `separate` / `separateWith` (crowds, with the spatial index), `SpatialHash` (client, workers — on the server prefer `spatial` + `ctx.near`), `launch` + `stepProjectiles` (+ `ballisticAngle`), `cooldown.use`, `every`, `schedule`/`due`, `status.apply/value` (buffs, slows, stuns), `createMatch`/`setReady`/`stepMatch`/`endMatch` (rounds), `createTurns`/`nextTurn`/`freezeTurn` (turn-based), inventory (`addItem`, `takeItem`), `balancedTeam`, `weighted`/`shuffle`/`pointInRing`, `addEffect`/`pruneEffects`.

## 6. Validate client input

Everything from the client is untrusted: check types (`Number.isFinite`), clamp ranges, check ownership/turn/cooldown/cost on the server. Return a string from `command()` to show the player why an action was refused.

## 7. Keep the client in sync

- If you changed shared movement, prediction on the client uses the same function automatically.
- Show new state in the HUD (`src/client/hud.ts` / `main.ts`) and scene; read the catalog for module data.
- New sound or event → handle it in the client's `net.on('event')` (forwarded bus events carry their payload).

## 8. Verify

```sh
npm run check && npx vitest run games/<game>
```

Write or extend a test in `games/<game>/tests/` with `testGame(game, { seed: 1 })` — the same engine as the server: `t.join`, `t.input`, `t.run(seconds)`, `t.command`, then assert on the world and on `t.triggeredOf('<event>')`; `t.ctx.timeLeft(key)` for timers. For saves: `testGame(game, { world: oldShapedWorld })` hydrates and migrates it like a checkpoint — assert the new fields. With a dev server running, poke the live game: `cd games/<game> && npx gaime world <field>`, `npx gaime admin …`.

## Pitfalls

- `setTimeout`, module-level `let`, closures holding state → lost on hot reload, not saved. Use timers and `data`.
- Calling modules from the core, or modules calling each other → use events and modifiers.
- A handler that triggers its own event → event storm, the owner is switched off (a module) or the game pauses (game code).
- `Math.random()` / `Date.now()` in the simulation → untestable, breaks replays; use `ctx.random`, `world.time`.
- Looping every entity over every entity → the module or game eats the tick (modules get throttled over their time budget, `⚡` in the feed); use the spatial index.
- A module-level cache (`const grid = new SpatialHash()`, `let navMesh`) → survives nothing and breaks replays; use `ctx.resource`.
- Changing `name` in `defineGame` resets everyone's identity and the save. Don't.
- A thrown exception in `step` or the game's own systems/handlers pauses the game for everyone — test before pushing (`testGame` is strict and throws).

## Reference

`docs/SIMULATION.md` (the model: spatial index, resources, budgets, determinism), `docs/SERVER.md` (context, commands, errors, persistence, rooms, replays), `docs/ROOMS.md`, `docs/PHYSICS.md`, `docs/KIT.md`, `docs/COOKBOOK.md` (events, modifiers, timers, rounds, teams, turns, shops, hidden information, migrations), `games/blank` (the reference implementation).
