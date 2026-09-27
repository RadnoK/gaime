# Architecture

```text
 browser                                        server (one process per game)
┌──────────────────────────┐   WebSocket    ┌───────────────────────────────────────────┐
│ main.ts                  │  (MessagePack) │ Colyseus (inside Vite dev or a build)     │
│  GameClient ─────────────┼──── input ────▶│  GameRoom (createRoomClass)               │
│   ├ welcome / patch ◀────┼──── patch ─────┤   ├ sessions, identities, host, reconnect │
│   ├ request ─────────────┼──── response ──┤   ├ 30 Hz tick: game.step(world, inputs)  │
│   └ event ◀──────────────┼──── event ─────┤   ├ 15 Hz publish: diff of a projection   │
│  Three.js scene, HUD     │                │   ├ checkpoint every 2 s (atomic)         │
└──────────────────────────┘                │   └ onCacheRoom/onRestoreRoom (HMR)       │
                                            │  module registry  ← src/features/*/server │
                                            │  worker pools     ← src/workers/*         │
                                            │  /health /gaime/room /gaime/stats /admin  │
                                            └───────────────────────────────────────────┘
                                                          ▲ sync + touch / restart
                                            ┌─────────────┴─────────────────────────────┐
                                            │ gaime host (supervisor): git fetch / 3 s  │
                                            └───────────────────────────────────────────┘
```

## Packages

| Import | Runs in | Contents |
| --- | --- | --- |
| `@gaime/core` | everywhere | `BaseWorld`, `BasePlayer`, `Visual`, delta sync (`projectWorld`/`diffWorld`/`applyWorldPatch`), `InputGate`, `createRegistry`, `baseWorld`, `hydrate`, `pushFeed`, `findPlayer`, math, protocol |
| `@gaime/core/server` | server | `defineGame`, `createGameServer`, `GameContext`, `workerPool`, `testContext`, checkpoints |
| `@gaime/core/client` | browser | `GameClient`, `watchVersion`, `Keyboard`, `Pointer`, `ServerClock`, `Interpolator`, `createFeatureModules` |
| `@gaime/core/three` | browser | `createStage`, `ModelLibrary`, `EntityLayer`, `createLabel`, `pickGround` |
| `@gaime/core/worker` | worker | `defineWorker` |
| `@gaime/core/vite` | vite.config | the `gaime()` plugin |
| `@gaime/host` | Node CLI | `gaime` (supervisor, status, rollback, admin, smoke, load, new) |

Packages are TypeScript sources in the monorepo (npm workspaces) — there is no build step. Vite resolves `@gaime/core*` with an alias to the source directory of the tree that is actually running (important for the supervisor's releases and candidates), TypeScript through `paths` in `tsconfig.base.json`.

## A game = a definition + a client

The game server boils down to three files:

```ts
// src/server/game.ts
export const game = defineGame<World, Input>({
  name: 'my-game',                  // room, checkpoint and localStorage key — never change it
  createWorld, createPlayer, parseInput, step, command,
  network: { entities: ['players', 'enemies'], streams: ['feed', 'effects'], shared: ['catalog'] },
});
// src/server/index.ts
export const server = createGameServer(game);
// src/server/registry.ts
export const registry = createRegistry<Kinds>(import.meta.glob('../features/*/server.ts', { eager: true }), { kinds: [...] });
```

The engine (`packages/core/src/server/room.ts`) provides:

- **One shared room** per game (`/gaime/room` returns its id; no extra rooms appear when it fills up).
- **Identity**: the browser keeps a random `ticket` (localStorage, separate per `?player=`); the server maps it to a player id (privately, in the checkpoint, never sent to clients). Refresh, server restart, new tab — same character. A new tab takes the character over (the old one gets close code 4103).
- **`keepPlayers`**: `true` (default) — the character stays in the world while offline; `false` — leaving frees the seat (duels). After a process restart seats wait 60 s.
- **Game host**: `world.hostId` = the first online player; it moves on when they disconnect.
- **Input lease**: a player's last input holds for 400 ms (the client repeats it every 150 ms); a lost client stops moving.
- **Error isolation**: an exception in `step` or a hook → `world.pause = { reason: 'error' }`, a message in the feed, `/health` reports the error. The next code load (HMR/restart) resumes the game. An exception in a command → a notice to its author only.
- **Checkpoint** `<data>/checkpoint.json` every ~2 s (when time moves or something changed), on shutdown and before HMR; written via rename. An unreadable save is never overwritten (`frozen`).
- **Migrations**: on load, `hydrate` fills missing fields from `createWorld()` and a player template, then `game.migrate(world)` runs; `prepare(world)` refreshes derived data (e.g. the module catalog).

## Hot reload

**Client** (Vite HMR): `main.ts` calls `import.meta.hot.accept()` and cleans up in `dispose`; `GameClient` lives in `import.meta.hot.data`, so changing the scene/HUD neither drops the connection nor reloads the page. CSS swaps by itself.

**Server** (the `colyseus/vite` plugin): changing any module in the server graph → the whole server code is evaluated again → `matchMaker.hotReload()`: `onCacheRoom` (save + cache world, identities, sessions) → a new room with the new code → `onRestoreRoom` (hydrate + migrate + prepare) → clients come back through devMode reconnection with the same `sessionId`. The `gaime()` plugin additionally:

- discovers new/removed directories in `src/features/` (touches the registry),
- holds the backend reload while the supervisor syncs a tree (the `applying` file) and merges a burst of changes into one reload,
- gives workers access to the Vite environment (TypeScript in workers with HMR),
- adds `dist/server/workers/*.mjs` and `gaime-worker.mjs` to the production build.

What HMR cannot carry over: dependency changes (`package.json`/lockfile) and Vite configuration — the supervisor then does a short restart from the checkpoint. Express (`game.routes`) is registered once per process.

**Production without Vite** (release mode): every release is a new process; browsers notice the new version via `/health` (`watchVersion`) and reload, keeping their identity and rejoining.

## Data flow in one tick

1. Apply the results of finished `ctx.job`s (workers, asynchronous requests).
2. `world.time += dt` (unless paused), `game.step(world, inputs, dt, ctx)`.
3. Every `publishEvery` ticks: `projectWorld` (a copy, rounded, without `hidden`) → one `diffWorld` and one encoding per group of clients sharing a base → `enqueueRaw`. A client with a clogged buffer (>64 KB) is skipped until it drains.
4. A checkpoint every ~2 s.

## Tests

- `packages/core/tests` — delta sync, registry, hydrate, workers, a real server with WebSocket clients (smoke, errors, chat, RPC, events, jobs, a corrupt checkpoint).
- `packages/host/tests` — tree sync, `node_modules` linking, dependency key, commit filter, load templates.
- `games/*/tests` — game logic on `testContext`.
- `gaime smoke --hmr` — E2E against a running server including a backend hot reload.
