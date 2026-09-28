# Blank (games/blank) — instructions for AI agents

The smallest complete gaime game: players walk on a square field and collect pickups for points. It exists to be copied (`npm run new-game -- my-game`, the default template) and turned into something else, so every file is short and shows one framework mechanism. It is also the **reference implementation of the simulation model**: events, modifiers, a `Sim` facade, systems (one periodic), a timer per pickup, an isolated definition hook, a behaviour-only module and `testGame` tests.

Read the general rules in [../../AGENTS.md](../../AGENTS.md) and the model in [../../docs/SIMULATION.md](../../docs/SIMULATION.md) first. How to extend this game: [docs/ADDING_FEATURES.md](docs/ADDING_FEATURES.md). How to turn it into a new game: [../../docs/NEW_GAME.md](../../docs/NEW_GAME.md) and the `gaime-new-game` skill.

## Files

| File | What it shows |
| --- | --- |
| `src/shared/types.ts` | `World`, `Player`, `Pickup`, `Input`, `Command`; the bus: `Events`, `Modifiers`; the `Sim` module code receives; the module kind `pickups` (`PickupDef`); `Feature` |
| `src/shared/rules.ts` | constants (`RULES`) and `movePlayer`, shared by the server and client prediction (`moveTopDown`, `clampToRect` from the kit) |
| `src/server/simulation.ts` | `createWorld`, `createPlayer`, `prepareWorld`, `makeSim` (the `Sim`, incl. `spawnPickup`), `step` (movement), the `collect` and `spawn` systems, `command`, the bot brain |
| `src/server/game.ts` | `defineGame<World, Input, Sim, Events, Modifiers>`: network config (forwards `pickup.collected`), `features`, `sim`, `systems`, `on` (scoring, expiry), input validation, `command`, `bot` |
| `src/server/registry.ts` | module discovery + validation of `pickups` |
| `src/client/main.ts` | `GameClient` kept across HMR, `Controls` + `TouchControls`, `net.onEvent('pickup.collected')` playing a sound; the optional default HUD (`GameUi`) with one widget |
| `src/client/scene.ts` | a placeholder look with the optional Three.js helpers: `createStage`, `CameraRig`, `EntityLayer`, `ModelLibrary`, interpolation and prediction |
| `src/features/coins/server.ts` | a content module: two pickups (`coin`, `gem`) |
| `src/features/combo/server.ts` | a behaviour-only module: `on` + `modify`, no definitions |
| `tests/simulation.test.ts` | `testGame` tests: spawning, collecting, the combo module, expiring timers, the host-only command, a bot |

## One tick

The engine runs, in this order (see `src/server/game.ts`):

1. due timers fire (`pickup.expired`);
2. `step` moves every online player by their input;
3. systems: `collect` (every tick), `spawn` (every `RULES.spawnEvery` s, while fewer than `RULES.maxPickups` lie on the field), then module systems;
4. events triggered along the way reach the `on` handlers — the game's first, then modules' in file order.

## Events (`Events` in `src/shared/types.ts`)

| Event | Payload | Triggered by | Handled by |
| --- | --- | --- | --- |
| `pickup.spawned` | `{ pickup, kind }` | `sim.spawnPickup` | — (free for modules) |
| `pickup.collected` | `{ playerId, pickup, kind, points }` — `points` already went through `pickup.points` | the `collect` system | the game adds `points` to the score; `combo` starts its window; forwarded to clients (sound) |
| `pickup.expired` | `{ pickup }` | the timer `pickup:<id>` set by `spawnPickup` (after `def.life ?? RULES.pickupLife` s) | the game removes the pickup |

Plus the engine's events on every game: `player.joined` `{ player, bot }`, `player.online` `{ player }`, `player.offline` `{ player }`, `player.removed` `{ player, name }`.

## Modifiers (`Modifiers`)

| Modifier | Value | Data | Used in |
| --- | --- | --- | --- |
| `pickup.points` | the points a pickup is worth (starts at `def.value`) | `{ playerId, kind }` | `collect`, before `pickup.collected` is triggered |

## The `Sim` (what handlers, systems, module commands and hooks receive)

| Member | Use |
| --- | --- |
| `world`, `dt` | the world; seconds since the last run (a tick, or a periodic system's interval) |
| `random()` | seeded in tests — never `Math.random()` |
| `trigger(event, data)` | put one of the game's `Events` on the bus |
| `after(seconds, event, data, { key? })` | fire one of the game's `Events` later (saved with the world; the same key replaces the timer) |
| `cancel(key)` | cancel a timer |
| `modify(name, value, data)` | run a value through the `modify` handlers |
| `log(text)`, `emit(name, data?, playerId?)` | a feed line for everyone; a one-off client event |
| `isolate(module, run)` | run code owned by a module (an error switches the module off, not the game) |
| `spawnPickup(kind?, at?)` | place a pickup (random weighted kind and position by default): sets its expiry timer and triggers `pickup.spawned` |

`Sim.trigger` and `Sim.after` accept the game's `Events` only; a module that needs its own timed event adds it to `Events` (or asks for a `Sim` helper).

## Module kind `pickups` (`PickupDef`)

| Field | Meaning |
| --- | --- |
| `id`, `name`, `description` | stable, prefixed id; player-facing name and text |
| `value` | points for collecting it (then adjusted by `pickup.points`) |
| `weight` | relative spawn chance (`coin` 10, `gem` 1) |
| `visual` | `Visual` — a built-in shape or a model registered by a module's `client.ts` |
| `life?` | seconds before it expires; default `RULES.pickupLife` (20) |
| `onPickup?(sim, player, pickup)` | extra effect when collected. It runs inside the `collect` system right after `pickup.collected` is triggered — so before the event's handlers (scoring, combo), which run when the system finishes — and through `sim.isolate`: a throwing hook switches its module off, the game keeps running |

## Adding content

A new pickup = `src/features/<id>/server.ts`:

```ts
import type { Feature } from '../../shared/types';
export default {
  author: 'Ola',
  pickups: [{ id: 'ola-star', name: 'Star', description: 'Ten points.', value: 10, weight: 0.5, visual: { shape: 'octahedron', color: '#ffe066', lift: 0.4 } }],
} satisfies Feature;
```

New behaviour without new content = a module with `on`, `modify`, `systems` or `commands` — `features/combo` and the examples in [docs/ADDING_FEATURES.md](docs/ADDING_FEATURES.md). For anything bigger (enemies, abilities, rounds) add events/modifiers (`gaime-mechanic` skill) or a new module kind (`gaime-module-kind` skill).

## Testing

```ts
const t = testGame(game, { random: seeded(1) });
const ada = t.join('Ada');
t.act(sim => sim.spawnPickup('coin', t.player(ada)));   // a pickup right under Ada
t.tick();
expect(t.player(ada).score).toBe(1);
expect(t.triggeredOf('pickup.collected')).toHaveLength(1);
```

`npx vitest run games/blank` — see `tests/simulation.test.ts` and [../../docs/TESTING.md](../../docs/TESTING.md).
