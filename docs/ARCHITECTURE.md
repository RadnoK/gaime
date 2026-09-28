# Architecture

```text
 browser                                        server (a game process; matches mode: one or more)
┌──────────────────────────┐   WebSocket    ┌────────────────────────────────────────────┐
│ main.ts                  │  (MessagePack) │ Colyseus (inside Vite dev or a build)      │
│  GameClient ─────────────┼─ room + seat ─▶│ matchmaking.ts (POST /gaime/room)          │
│   ├ input / command ─────┼──── input ────▶│  GameRoom (room.ts) — the network side     │
│   ├ welcome / patch ◀────┼──── patch ─────┤   ├ sessions, identities, reconnect, leases│
│   ├ request ─────────────┼──── response ──┤   ├ fixed-step clock (catch-up ≤ 3 ticks)  │
│   └ event ◀──────────────┼──── events ────┤   ├ 15 Hz publish: diff of a projection    │
│  your scene, HUD, sounds │   (batched)    │   ├ batched client events, checkpoints     │
└──────────────────────────┘                │   ├ saved recordings, admin, room lock     │
                                            │   └ onCacheRoom/onRestoreRoom (HMR)        │
                                            │  Engine (engine.ts) — the simulation       │
                                            │   ├ world.time / world.tick, world.rng     │
                                            │   ├ timers (world.schedule), event bus     │
                                            │   ├ systems, step, modifiers, commands     │
                                            │   ├ spatial index, resources, budgets      │
                                            │   ├ flight recorder (recorder.ts)          │
                                            │   └ module isolation, bots, jobs, players  │
                                            │  module registry  ← src/features/*/server  │
                                            │  worker pools     ← src/workers/*          │
                                            │  /health /gaime/room /gaime/stats /admin   │
                                            └────────────────────────────────────────────┘
                                                          ▲ sync + touch / restart
                                            ┌─────────────┴──────────────────────────────┐
                                            │ gaime host (supervisor): git fetch / 3 s   │
                                            └────────────────────────────────────────────┘
```

The simulation model — clock, event bus, modifiers, timers, systems, isolation, the spatial index, resources, budgets, replays — is described in [SIMULATION.md](SIMULATION.md); room modes, matchmaking and scaling out in [ROOMS.md](ROOMS.md). This page is about how the pieces fit together.

## Packages

| Import | Runs in | Contents |
| --- | --- | --- |
| `@gaime/core` | everywhere | `BaseWorld`, `BasePlayer`, `Visual`, delta sync (`projectWorld`/`diffWorld`/`applyWorldPatch`), `InputGate`, `createRegistry` and module types (`FeatureModule`, `SystemDef`, `EventMap`), the timer heap (`schedule.ts`), `baseWorld`, `hydrate`, `pushFeed`, `findPlayer`, math (`clamp`, `lerp`, `dist`, `angleTo`, `nearest`, `seeded`…), protocol |
| `@gaime/core/server` | server | `defineGame`, `createGameServer`, `GameContext`, `Engine`, `testGame`, `testContext`, `replay`, `worldHash`, `workerPool`, checkpoints, `normalizeCode` |
| `@gaime/core/kit` | everywhere | pure gameplay helpers: collision/raycasts, `SpatialHash`, projectiles, cooldowns/status/timers, match lifecycle, turns, inventory, random, teams, effects, movement ([KIT.md](KIT.md)) |
| `@gaime/core/client` | browser | `GameClient`, `watchVersion`, `Controls`, `TouchControls`, `Scope`/`keep`, `Keyboard`, `Pointer`, `ServerClock`, `Interpolator`, `createFeatureModules` |
| `@gaime/core/ui` | browser | optional default HUD: `GameUi` (lobby, status, menu, roster, chat, toasts, banner, dialogs, F3 stats), DOM helpers, `ui.css` |
| `@gaime/core/three` | browser | optional rendering helpers: `createStage`, `CameraRig`, `ModelLibrary` (+ glTF), `EntityLayer`, `EffectsLayer`, bars, labels, `pickGround` |
| `@gaime/core/audio` | browser | optional: `SoundBank`, `tones` |
| `@gaime/core/worker` | worker | `defineWorker` |
| `@gaime/core/vite` | vite.config | the `gaime()` plugin |
| `@gaime/physics` | server | optional rigid-body physics (Rapier 2D) over plain-JSON entities, as an engine system and a `ctx.resource` ([PHYSICS.md](PHYSICS.md)) |
| `@gaime/host` | Node CLI | `gaime` (supervisor, status, rollback, admin, smoke, load, new) |

Packages are TypeScript sources in the monorepo (npm workspaces) — there is no build step. Vite resolves `@gaime/core*` with an alias to the source directory of the tree that is actually running (important for the supervisor's releases and candidates), TypeScript through `paths` in `tsconfig.base.json`.

The browser packages (`ui`, `three`, `audio`) are conveniences, not a prescribed look: a game can replace any of them — or all of them — with its own interface, renderer and sound. Only `@gaime/core/client` (the connection) is needed on the browser side.

## A game = a definition + a client

The game server boils down to three files:

```ts
// src/server/game.ts
export const game = defineGame<World, Input, Sim, Events, Modifiers>({
  name: 'my-game',                  // room, checkpoint and localStorage key — never change it
  features: registry,               // modules' on / modify / systems / commands
  sim: (ctx, dt) => makeSim(registry, ctx, dt),
  createWorld, createPlayer, parseInput, command,
  step,                             // optional: input handling (world, inputs, dt, ctx, sim)
  systems: [{ id: 'spawn', every: 2, run: spawn }],
  on: { 'enemy.died': reward },
  network: { entities: ['players', 'enemies'], streams: ['feed', 'effects'], shared: ['catalog'], events: ['enemy.died'] },
});
// src/server/index.ts
export const server = createGameServer(game);
// src/server/registry.ts
export const registry = createRegistry<Kinds>(import.meta.glob('../features/*/server.ts', { eager: true }), { kinds: [...] });
```

`games/blank/src/server/game.ts` is the smallest complete example.

## Engine and room

The server side of the framework is split in two:

| | `Engine` — `packages/core/src/server/engine.ts` | `GameRoom` — `packages/core/src/server/room.ts` |
| --- | --- | --- |
| Owns | the world, the clock (`world.time`, `world.tick`), the random generator (`world.rng`), timers, the event bus, modifiers, systems, `step`, commands (game and modules), chat, bots, jobs, the player lifecycle, module isolation, module time budgets, resources, spatial indexes, the flight recorder (`recorder.ts`) | connections, identities (tickets), sessions, reconnection, input leases, the real-time loop, publishing patches, batched client events, checkpoints (shared mode), saving recordings, hot-reload cache/restore, the admin API, the room lock and listing (matches mode) |
| Knows about the network | no — it talks to an `EngineHost` (`notify`, `send`, `disconnect`, `changed`, `profile`, `throttled`, `room`, `lockRoom`…) | yes |
| Driven by | the room in production, `testGame` in tests, `replay()` for recordings | Colyseus; rooms are created by `matchmaking.ts` |

Because tests drive the same `Engine`, a `testGame` run executes exactly the ticks the server would ([TESTING.md](TESTING.md)), and `replay()` (`replay.ts`) can drive a fresh engine with what a live room recorded.

What the engine and the room provide together:

- **Rooms** (`GameDefinition.rooms`, [ROOMS.md](ROOMS.md)): `shared` (default) — exactly one persistent room per game, no extra rooms appear when it fills up; `matches` — many rooms of `size` seats, each with its own `Engine` and world, created by `matchmaking.ts` (`POST /gaime/room`: public matchmaking, invite codes, rejoining the tab's room) and closed when empty. Several processes can share the room listing through Redis in release mode.
- **Identity**: the browser keeps a random `ticket` (localStorage, separate per `?player=`); the server maps it to a player id (privately, in the checkpoint, never sent to clients; per room in matches mode). Refresh, server restart, new tab — same character. A new tab takes the character over (the old one gets close code 4103).
- **`keepPlayers`**: `true` (default) — the character stays in the world while offline; `false` — leaving frees the seat (duels). After a process restart seats wait 60 s.
- **Game host**: `world.hostId` = the first online human player; it moves on when they disconnect.
- **Bots**: players driven by `GameDefinition.bot` on the server (`/bot`, `ctx.addBot`), using the same inputs and commands as humans.
- **Per-player views**: an optional `view(world, playerId)` filters what each client receives (hidden information).
- **Input lease**: a player's last input holds for 400 ms (the client repeats it every 150 ms); a lost client stops moving.
- **Error isolation**: an exception in code owned by a module (its handlers, modifiers, systems, or a definition hook run through `ctx.isolate`) switches **that module** off — a ⚠ line in the feed, `disabled` in `/health` — and the game keeps running. An exception in the game's own code (`step`, the game's systems and handlers, `bot`, `prepare`, a job's `apply`) → `world.pause = { reason: 'error' }`, a message in the feed, `/health` reports the error. The next code load (HMR/restart) switches modules back on and resumes the game. An exception in a command → a notice to its author only.
- **Checkpoint** (shared mode) `<data>/checkpoint.json` every ~2 s (when time moves or something changed), on shutdown and before HMR; written via rename. The timer queue (`world.schedule`) and the random generator (`world.rng`) are part of the world, so timers survive restarts. An unreadable save is never overwritten (`frozen`). Match worlds live in memory: HMR keeps them, a restart ends them.
- **Module time budgets**: the engine charges each module for the time its systems and handlers take; a module over `budget.moduleMs` (default 20% of the tick) has its systems throttled to every 2nd–8th tick until it recovers, instead of lagging everyone (`/gaime/stats` → `throttled`).
- **Spatial index**: collections listed in `GameDefinition.spatial` get one grid per tick, shared by every system and module (`ctx.near`, `ctx.nearest`).
- **Flight recorder**: the engine records every external entry (inputs, commands, joins, operator actions, requests, job results, throttling) with world snapshots for the last minutes; the room writes it to `<data>/replays/` when the game pauses on an error, a module is switched off, or an operator runs `gaime replay`. `replay(game, recording)` re-runs it deterministically ([SIMULATION.md](SIMULATION.md#determinism-and-replays)).
- **Migrations**: on load, `hydrate` fills missing fields from `createWorld()` and a player template, then `game.migrate(world)` runs; `prepare(world)` refreshes derived data (e.g. the module catalog).

## Hot reload

**Client** (Vite HMR): `main.ts` calls `import.meta.hot.accept()` and cleans up in `dispose`; `GameClient` lives in `import.meta.hot.data`, so changing the scene/HUD neither drops the connection nor reloads the page. CSS swaps by itself.

**Server** (the `colyseus/vite` plugin): changing any module in the server graph → the whole server code is evaluated again → `matchMaker.hotReload()`: `onCacheRoom` (save + cache world, identities, sessions) → a new room with a new `Engine` built from the new code (handlers, modifiers and systems re-collected, disabled modules cleared, resources disposed and recreated on first use, a new flight recording started) → `onRestoreRoom` (hydrate + migrate + prepare; periodic systems re-staggered from the current `world.time`) → clients come back through devMode reconnection with the same `sessionId`. Timers live in the world and keep counting across the reload. The `gaime()` plugin additionally:

- discovers new/removed directories in `src/features/` (touches the registry),
- holds the backend reload while the supervisor syncs a tree (the `applying` file) and merges a burst of changes into one reload,
- gives workers access to the Vite environment (TypeScript in workers with HMR),
- adds `dist/server/workers/*.mjs` and `gaime-worker.mjs` to the production build.

In matches mode every room goes through the same cache/restore, lock included. What HMR cannot carry over: dependency changes (`package.json`/lockfile) and Vite configuration — the supervisor then does a short restart from the checkpoint (match worlds are lost). Express (`game.routes`) is registered once per process. Pending `ctx.job`s are dropped.

**Production without Vite** (release mode): every release is a new process; browsers notice the new version via `/health` (`watchVersion`) and reload, keeping their identity and rejoining.

## One tick

The room runs a **fixed-step clock**: the Colyseus interval accumulates real time and runs as many engine steps of exactly `1 / tickRate` s as fit, at most 3 at once. When the server falls further behind, the rest is dropped (reported as `droppedMs` in `/gaime/stats`) — the game slows down briefly instead of spiralling.

Each engine step (`Engine.step`):

1. Record changed inputs (flight recorder); apply the results of finished `ctx.job`s (workers, asynchronous requests). Nothing else happens while paused.
2. Once a second, review module budgets (throttle or relax). Ask `game.bot()` for every bot's input; humans' inputs are their last input within the lease.
3. `world.time += dt`, `world.tick++`; timers that became due (at most 5 000) fire their events.
4. `input` systems → `game.step(world, inputs, dt, ctx)` → `update` systems → `late` systems. The game's systems run before modules' systems in each phase; periodic (`every`) systems run only when due; systems of a throttled module run every n-th tick. Spatial indexes are rebuilt lazily, at the first query of the tick.
5. Every event triggered along the way is dispatched right after the (outermost) piece of code that raised it: the game's `on` handlers first, then the modules', FIFO. Events listed in `network.events` are also queued for clients. Player changes (join, online, offline, removal) trigger the engine events `player.joined`, `player.online`, `player.offline`, `player.removed`.
6. The recorder closes the tick: every 150 ticks it stores a world hash; when the segment is full it starts a new one with a snapshot.

Then the room:

7. Sends the tick's client events — one `events` message per client (at most 256 events), [PROTOCOL.md](PROTOCOL.md).
8. Every `publishEvery` ticks: `projectWorld` (a copy, rounded, without `hidden` keys and `schedule`) → one `diffWorld` and one encoding per group of clients sharing a base (per client when `view` is set) → `enqueueRaw`. A client with a clogged buffer (>64 KB) is skipped until it drains.
9. A checkpoint every ~2 s (shared mode); in matches mode, once a second, the room's listing is refreshed and an empty room closes after `GAIME_EMPTY_ROOM_SECONDS`.

Commands, requests and admin commands arrive between ticks; the engine records them, runs them and dispatches the events they trigger immediately.

## Tests

- `packages/core/tests` — the engine (`engine.test.ts`: timer heap, event order, modifiers, systems, module commands, isolation, storms, forwarding, `testGame`/`testContext`), determinism, recordings and replays (`determinism.test.ts`), rooms, matchmaking and invite codes (`rooms.test.ts`), delta sync, registry, hydrate, kit, workers, a real server with WebSocket clients (smoke, errors, chat, RPC, events, jobs, per-player views, bots, admin API, a corrupt checkpoint).
- `packages/host/tests` — tree sync, `node_modules` linking, dependency key, commit filter, load templates.
- `packages/physics/tests` — the physics package (determinism, hot reload, benchmarks).
- `games/*/tests` — game logic on `testGame` (the full engine without a network), including bot-vs-bot rounds and a record-and-replay determinism test. See [TESTING.md](TESTING.md).
- `gaime smoke --hmr` — E2E against a running server including a backend hot reload.
