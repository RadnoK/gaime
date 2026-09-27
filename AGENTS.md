# gaime — instructions for AI agents

A monorepo framework for multiplayer browser games developed by several people at once, each with their own AI. Games run live on a server that deploys every push to `main` within seconds. Your changes reach people who are playing right now — write code that does not break their game.

**Language:** everything in the repository is English — code, identifiers, comments, UI strings, log and error messages, docs, commit messages and in-game content — even if the user talks to you in another language.

## Before you start

- You work inside a specific game: read **`games/<game>/AGENTS.md`** (that game's module API) and `games/<game>/src/shared/types.ts`.
- Adding content to a game → **a new directory `games/<game>/src/features/<unique-id>/`** (`server.ts`, optionally `client.ts`). The registry discovers it; never add imports to a central list.
- Change the engine (`packages/core`, `packages/host`) only when a game really needs it. It is shared by every game — read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and add a test.

## Hard rules (otherwise the game breaks)

1. **The server is authoritative.** Clients send intents (`input`, `command`, `request`), never results (damage, score, other players' positions). Validate every client value on the server.
2. **All persistent state lives in `World`** (or `player.data` / `entity.data` with keys prefixed by the module id). No module-level variables, no classes with fields, no `setTimeout`/`setInterval` for game logic. Time is `world.time` and `dt` (seconds). Reason: hot reload swaps modules, and the checkpoint saves only `World`.
3. **`World` must be plain JSON**: numbers, strings, booleans, objects, arrays. No `Map`, `Set`, `Date`, class instances, functions, or meaningful `undefined`.
4. **Definition ids in modules are globally unique and stable** (prefix them with the module name). They are stored in checkpoints.
5. **Save compatibility.** New `World`/player fields get defaults automatically (from `createWorld()` / `createPlayer()`). Changing the meaning or type of an existing field requires bumping `SCHEMA` and a migration in `migrate()`. Never delete a checkpoint.
6. **Server code never reaches the client**: `client/*` must not import `server/*` or `features/*/server.ts`. The client gets the catalog (`world.catalog`) and `Visual` descriptors.
7. **An error must not stop the loop for long**: an exception in `step` pauses the game with a message, and a deploy that does not start is reverted — but players see it. Check before you push.
8. **Client HMR**: `main.ts` must clean up everything in `import.meta.hot.dispose` (loops, listeners, WebGL). Keep the server connection in `import.meta.hot.data`.
9. **Never mutate a world received on the client** — consecutive patches share unchanged objects.
10. Heavy computation (pathfinding, map generation, analysis) → a worker (`src/workers/<name>.ts`, `workerPool`) + `ctx.job(...)`. The simulation loop has ~33 ms per tick for everyone.

## Collaborating on main

- Work directly on `main`, no PRs. Commit only your own changes: `git add <your files>`, `git commit`, `git pull --rebase origin main`, resolve conflicts, `git push origin main`. Never `--force`.
- Do not overwrite other people's or uncommitted changes. Do not reformat other people's files.
- Before pushing: `npm run check` and `npm test` (the server runs the typecheck as a gate anyway — an invalid commit will not go live, and you block the queue until the next push).
- After a push the server: fetches the commit (≤ 3 s) → typecheck → sync → hot reload → confirmation via `/health`. State: `cd games/<game> && npx gaime status` (locally) or on the server (docs/DEPLOYMENT.md).

## Skills (step-by-step playbooks)

`.claude/skills/` (also `.agents/skills/`) — load the matching one before you start ([docs/SKILLS.md](docs/SKILLS.md)):

| Task | Skill |
| --- | --- |
| new game from a template | `gaime-new-game` |
| new content in an existing game (enemy, weapon, ability, pickup…) | `gaime-feature` |
| a new kind of content / extension point | `gaime-module-kind` |
| core rules, world state, rounds, scoring, saves | `gaime-mechanic` |
| HUD, scene, models, effects, sound, controls | `gaime-client` |
| AI players, bot-vs-bot tests | `gaime-bot` |
| heavy computation | `gaime-worker` |
| sync, lag, bandwidth, load | `gaime-networking` |
| tests and pre-push checks | `gaime-test` |
| something is broken | `gaime-debug` |
| hosting, deploys, rollback | `gaime-deploy` |
| changing `packages/core` or `packages/host` | `gaime-engine` |

## Commands

```sh
npm install
npm run dev [-- <game>]           # http://localhost:5173, client and server HMR
npm run check                     # typecheck everything
npm test                          # vitest (framework + games)
npm run build                     # production build of every game
npm run smoke [-- <game>]         # E2E with real clients against a running dev server
npm run load [-- <game>]          # bots: RTT, tick/publish cost
npm run new-game -- <name> [--from blank|starter|duel] [--title "Title"]   # default template: blank
npx gaime help                    # every CLI command (inside a game directory)
```

Testing logic without the network: `testContext(world, { random, command })` from `@gaime/core/server` gives a full `GameContext` (collects notices and events, runs jobs). Bot vs bot rounds make good end-to-end rule tests.

## Map

- `packages/core/src/shared/` (`@gaime/core`) — base types (`BaseWorld`, `BasePlayer`, `Visual`), delta sync (`net.ts`), module registry, protocol, math.
- `packages/core/src/server/` (`/server`) — `defineGame`, `createGameServer`, the room (`room.ts`: sessions, bots, per-player views, admin), chat, checkpoints, workers, metrics, `testContext`.
- `packages/core/src/kit/` (`/kit`) — pure gameplay helpers: collision, `SpatialHash`, projectiles, cooldowns/timers/status effects, match lifecycle, turns, inventory, random, teams, effects, movement. Use these before writing your own.
- `packages/core/src/client/` (`/client`) — `GameClient`, `Controls`/`TouchControls` (keyboard, mouse, gamepad, touch), `Scope`/`keep` for HMR, `ServerClock`/`Interpolator`, `watchVersion`.
- `packages/core/src/ui/` (`/ui`) — `GameUi` (lobby, status, menu, roster, chat, toasts, banner, dialogs, F3 stats), DOM helpers, themable CSS.
- `packages/core/src/three/` (`/three`) — `createStage`, `CameraRig`, `ModelLibrary` (+ glTF), `EntityLayer`, `EffectsLayer`, bars, labels.
- `packages/core/src/audio/` (`/audio`) — `SoundBank`, synthesized `tones`.
- `packages/core/src/vite/` (`/vite`) — the `gaime()` plugin (Colyseus inside Vite, HMR, workers in the build).
- `packages/host/` — the `gaime` CLI and the deploy supervisor.
- `games/<game>/` — a game: `src/shared` (types, rules shared with the client), `src/server` (simulation, registry), `src/client` (rendering, HUD), `src/features/*`, `src/workers/*`, `tests/`. Templates: `blank` (minimal), `starter` (Crystal, co-op defense), `duel` (turn-based artillery) — [docs/TEMPLATES.md](docs/TEMPLATES.md).
- Docs: [index](docs/README.md) — [GETTING_STARTED](docs/GETTING_STARTED.md), [TUTORIAL](docs/TUTORIAL.md), [ARCHITECTURE](docs/ARCHITECTURE.md), [SERVER](docs/SERVER.md), [CLIENT](docs/CLIENT.md), [KIT](docs/KIT.md), [MODULES](docs/MODULES.md), [COOKBOOK](docs/COOKBOOK.md), [PROTOCOL](docs/PROTOCOL.md), [TESTING](docs/TESTING.md), [DEPLOYMENT](docs/DEPLOYMENT.md), [TROUBLESHOOTING](docs/TROUBLESHOOTING.md), [reference/CONFIG](docs/reference/CONFIG.md), [reference/CLI](docs/reference/CLI.md).

## Don't

- Don't commit `.gaime/`, `.env`, keys, checkpoints, `node_modules`, `dist`.
- Don't deploy by hand, restart the server or change the VPS configuration unless the user asks — a push to `main` is enough.
- Don't add npm dependencies without need: a lockfile change triggers `npm ci` and a short restart for everyone (instead of a hot reload).
- Don't change the game `name` in `defineGame` — it keys the checkpoint and the players' browser identities.
