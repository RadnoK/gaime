# gaime — instructions for AI agents

A monorepo framework for multiplayer browser games developed by several people at once, each with their own AI. Games run live on a server that deploys every push to `main` within seconds. Your changes reach people who are playing right now — write code that does not break their game.

**Language:** everything in the repository is English — code, identifiers, comments, UI strings, log and error messages, docs, commit messages and in-game content — even if the user talks to you in another language.

## Before you start

- Read **[docs/SIMULATION.md](docs/SIMULATION.md)** — the model every rule and module is written against: one clock, events, modifiers, timers, systems, module commands, isolation.
- You work inside a specific game: read **`games/<game>/AGENTS.md`** (that game's module API) and `games/<game>/src/shared/types.ts` (its `World`, `Events`, `Modifiers`, `Sim` and module kinds).
- Adding content or behaviour to a game → **a new directory `games/<game>/src/features/<unique-id>/`** (`server.ts`, optionally `client.ts`). The registry discovers it; never add imports to a central list.
- The framework provides mechanics, not looks: what players see and touch (HUD, scene, sounds, content) is designed by the game's authors. `GameUi`, `@gaime/core/three` and `@gaime/core/audio` are optional defaults — don't treat them as the required look.
- Change the engine (`packages/core`, `packages/host`) only when a game really needs it. It is shared by every game — read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and add a test.

## Hard rules (otherwise the game breaks)

1. **The server is authoritative.** Clients send intents (`input`, `command`, `request`), never results (damage, score, other players' positions). Validate every client value on the server.
2. **All persistent state lives in `World`** (or `player.data` / `entity.data` with keys prefixed by the module id). No module-level variables, no classes with fields, no `setTimeout`/`setInterval`/`Date.now()` for game logic. Time is `world.time` and `dt` (seconds). Reason: hot reload swaps modules, and the checkpoint saves only `World`.
3. **Use the engine's mechanisms** ([docs/SIMULATION.md](docs/SIMULATION.md)) instead of ad-hoc ones: per-tick and periodic work → **systems** (`every: seconds`, not `world.time % n` checks or counters decremented per tick); something later → a **timer** (`ctx.after`, not a countdown field); "when X happens, Y" → **trigger an event** and react with **`on`** (never call another module's functions or poll for changes); numbers others may adjust → **`ctx.modify`** + `modify` (server only — never for values the client predicts, like movement speed); a new player action from a module → module **`commands`**; players joining/leaving → the engine events `player.joined` / `player.online` / `player.offline` / `player.removed`. Give every timer that may need cancelling a **key prefixed by its owner** (`bomb:<id>`, `player:<id>:respawn` — `player:<id>:` keys are cancelled when the player is removed). Event payloads are plain JSON with ids, not objects.
4. **Run definition hooks isolated**: when game code calls a module's hook (`def.tick`, `def.onPickup`…), wrap it in `sim.isolate(registry.owner['<kind>/<id>'], …)` / `ctx.isolate`, so a bug switches that module off instead of pausing the game.
5. **`World` must be plain JSON**: numbers, strings, booleans, objects, arrays. No `Map`, `Set`, `Date`, class instances, functions, or meaningful `undefined`.
6. **Ids in modules are globally unique and stable** — definition ids, system ids, command types (`<module>-<action>`), module-private events (`<module>:<event>`, no entry in the game's `Events` needed), timer keys: prefix them with the module name. They are stored in checkpoints.
7. **Save compatibility.** New `World`/player fields get defaults automatically (from `createWorld()` / `createPlayer()`). Changing the meaning or type of an existing field requires bumping `SCHEMA` and a migration in `migrate()`. Pending timers are saved with their event name and payload — renaming an event or changing its payload needs the same care. Never delete a checkpoint.
8. **Server code never reaches the client**: `client/*` must not import `server/*` or `features/*/server.ts`. The client gets the catalog (`world.catalog`) and `Visual` descriptors.
9. **An error must not stop the loop for long**: an exception in module code switches that module off, an exception in game code (`step`, the game's systems/handlers) pauses the game, and a deploy that does not start is reverted — players see all of it. Check before you push.
10. **Client HMR**: `main.ts` must clean up everything in `import.meta.hot.dispose` (loops, listeners, WebGL). Keep the server connection in `import.meta.hot.data`.
11. **Never mutate a world received on the client** — consecutive patches share unchanged objects.
12. Heavy computation (pathfinding, map generation, analysis) → a worker (`src/workers/<name>.ts`, `workerPool`) + `ctx.job(...)`. The simulation loop has ~33 ms per tick for everyone; `/gaime/stats` → `parts` shows what each system and handler costs.

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
| new content or behaviour in an existing game (enemy, weapon, ability, pickup, a rule reacting to events…) | `gaime-feature` |
| a new kind of content / extension point | `gaime-module-kind` |
| core rules, world state, events/modifiers, systems, timers, rounds, scoring, saves | `gaime-mechanic` |
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
npm test                          # vitest (framework + games; games use testGame)
npm run build                     # production build of every game
npm run smoke [-- <game>]         # E2E with real clients against a running dev server
npm run load [-- <game>]          # bots: RTT, tick/publish cost
npm run new-game -- <name> [--from blank|starter|duel] [--title "Title"]   # default template: blank
npx gaime help                    # every CLI command (inside a game directory)
```

Testing logic without the network: `testGame(game, { random: seeded(1) })` from `@gaime/core/server` runs the whole game on the same engine as the server (clock, timers, events, systems, modules, commands, bots): `t.join`, `t.input`, `t.run(seconds)`, `t.command`, `t.triggeredOf(event)`. Module errors throw in tests (strict). `testContext(world)` gives a bare `GameContext` for unit tests of single functions. Bot vs bot rounds (`t.addBot()`) make good end-to-end rule tests.

## Map

- `packages/core/src/shared/` (`@gaime/core`) — base types (`BaseWorld`, `BasePlayer`, `Visual`), delta sync (`net.ts`), module registry and behaviour types (`registry.ts`), the timer heap (`schedule.ts`), protocol, math.
- `packages/core/src/server/` (`/server`) — `defineGame` (`game.ts`), the engine (`engine.ts`: clock, timers, event bus, modifiers, systems, commands, isolation, bots, players), the room (`room.ts`: sessions, fixed-step loop, publishing, batched events, per-player views, admin), `createGameServer`, chat, checkpoints, workers, metrics, `testGame`/`testContext` (`testing.ts`).
- `packages/core/src/kit/` (`/kit`) — pure gameplay helpers: collision, `SpatialHash`, projectiles, cooldowns/timers/status effects, match lifecycle, turns, inventory, random, teams, effects, movement. Use these before writing your own.
- `packages/core/src/client/` (`/client`) — `GameClient`, `Controls`/`TouchControls` (keyboard, mouse, gamepad, touch), `Scope`/`keep` for HMR, `ServerClock`/`Interpolator`, `watchVersion`.
- `packages/core/src/ui/` (`/ui`, optional) — `GameUi` (lobby, status, menu, roster, chat, toasts, banner, dialogs, F3 stats), DOM helpers, themable CSS.
- `packages/core/src/three/` (`/three`, optional) — `createStage`, `CameraRig`, `ModelLibrary` (+ glTF), `EntityLayer`, `EffectsLayer`, bars, labels.
- `packages/core/src/audio/` (`/audio`, optional) — `SoundBank`, synthesized `tones`.
- `packages/core/src/vite/` (`/vite`) — the `gaime()` plugin (Colyseus inside Vite, HMR, workers in the build).
- `packages/host/` — the `gaime` CLI and the deploy supervisor.
- `games/<game>/` — a game: `src/shared` (types, events, rules shared with the client), `src/server` (simulation, registry), `src/client` (rendering, HUD), `src/features/*`, `src/workers/*`, `tests/`. Templates: `blank` (minimal; the reference for events, modifiers, timers and systems), `starter` (Crystal, co-op defense), `duel` (turn-based artillery) — [docs/TEMPLATES.md](docs/TEMPLATES.md).
- Docs: [index](docs/README.md) — [SIMULATION](docs/SIMULATION.md) (the core guide), [GETTING_STARTED](docs/GETTING_STARTED.md), [TUTORIAL](docs/TUTORIAL.md), [ARCHITECTURE](docs/ARCHITECTURE.md), [SERVER](docs/SERVER.md), [CLIENT](docs/CLIENT.md), [KIT](docs/KIT.md), [MODULES](docs/MODULES.md), [COOKBOOK](docs/COOKBOOK.md), [PROTOCOL](docs/PROTOCOL.md), [TESTING](docs/TESTING.md), [DEPLOYMENT](docs/DEPLOYMENT.md), [TROUBLESHOOTING](docs/TROUBLESHOOTING.md), [reference/CONFIG](docs/reference/CONFIG.md), [reference/CLI](docs/reference/CLI.md).

## Don't

- Don't commit `.gaime/`, `.env`, keys, checkpoints, `node_modules`, `dist`.
- Don't deploy by hand, restart the server or change the VPS configuration unless the user asks — a push to `main` is enough.
- Don't add npm dependencies without need: a lockfile change triggers `npm ci` and a short restart for everyone (instead of a hot reload).
- Don't change the game `name` in `defineGame` — it keys the checkpoint and the players' browser identities.
