# gaime

A framework for quickly building **multiplayer browser games developed together with AI**. Everyone clones the repo, everyone adds their own modules with their own AI assistant, `git push` — and a few seconds later the new version is live for every player, without interrupting the game.

It grew out of [meet-proxy-2026](https://github.com/8lines/meet-proxy-2026) and [super-popes](https://github.com/osuperrly/super-popes): the infrastructure those games shared is extracted here, generalised and tested, so the games themselves stay small.

| Layer | What you get |
| --- | --- |
| **Networking** | Authoritative Colyseus server, one shared room, world delta sync (full snapshot + revisioned patches), input throttling, reconnection, persistent player identity per browser, taking over a character from another tab, RPC (`request`), server events, backpressure. [docs/PROTOCOL.md](docs/PROTOCOL.md) |
| **Server** | `defineGame()` — you write only the rules; the engine handles sessions, the game host role, checkpoints every 2 s, save migrations, error isolation (a broken module pauses the game instead of crashing it), chat with slash commands, worker pools for heavy computation, an admin API and metrics. [docs/SERVER.md](docs/SERVER.md) |
| **Modules** | `src/features/<id>/server.ts` (+ optional `client.ts` with 3D models) discovered automatically — add content without touching the core and without git conflicts. |
| **Gameplay kit** | Pure, tested helpers for the usual game rules: collision and raycasts, `SpatialHash`, projectiles with gravity/wind, cooldowns and status effects, rounds (lobby → countdown → play → result), turns, inventory, teams, weighted randomness, effects. [docs/KIT.md](docs/KIT.md) |
| **Client** | `GameClient` (connection, patches, RPC, events, network simulation `?lag=150&jitter=40&loss=5`, network stats), interpolation and prediction, `Controls` for keyboard/mouse/gamepad/touch, a ready-made HUD (`GameUi`: lobby, chat, roster, toasts, banner, dialogs, F3 stats), Three.js helpers (stage, camera rig with shake, models + glTF, entity layers, effects), sounds. [docs/CLIENT.md](docs/CLIENT.md) |
| **Bots and hidden info** | `bot()` brains for AI players (`/bot`), per-player `view` for cards in hand or fog of war. |
| **Hot reload** | Locally and **on the production server**: client HMR (no page reload, the connection stays) and server HMR (the room keeps its world and identities), discovery of new modules and workers. |
| **Deploy** | `gaime host` — a supervisor that follows `origin/main` every 3 s. **live** mode (sync + HMR, ~3 s from push) or **release** mode (isolated build, ~4 s restart, an nginx gateway keeps pages up). Gates (typecheck), automatic revert of a commit that does not start, `rollback`, checkpoint snapshots, hourly backups. Docker Compose + Traefik/Caddy, or systemd. [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) |
| **Tools** | `gaime` CLI: `status`, `rollback`, `players`, `say`, `kick`, `world`, `admin …`, `smoke`, `load` (bots, RTT p50/p99, tick cost), `new`. [docs/reference/CLI.md](docs/reference/CLI.md) |
| **AI workflow** | `AGENTS.md` rules plus 12 skills in `.claude/skills` (new game, feature, module kind, mechanic, client, bot, worker, networking, test, debug, deploy, engine). [docs/SKILLS.md](docs/SKILLS.md) |

Documentation index: [docs/README.md](docs/README.md). New here? [docs/GETTING_STARTED.md](docs/GETTING_STARTED.md), then the [tutorial](docs/TUTORIAL.md).

## Quick start

Requirements: **Node.js ≥ 22.12**, npm, git.

```sh
npm install
npm run dev            # example game "Crystal" at http://localhost:5173
```

A second player on the same machine: `http://localhost:5173/?player=2` (separate identity). On a LAN / Tailscale, share the machine's address with port 5173.

```sh
npm test               # framework and game tests
npm run check          # typecheck
npm run smoke          # end-to-end with real clients (against a running dev server)
npm run load           # 20 bots: RTT, tick and publish cost
npm run build          # production build of every game
```

## A new game

```sh
npm run new-game -- my-game --title "My Game"     # from games/blank; --from starter | duel
npm install
npm run dev -- my-game
```

This copies a template game with the name replaced. Then tell your AI what to build — [docs/NEW_GAME.md](docs/NEW_GAME.md) has ready-made prompts, [docs/TEMPLATES.md](docs/TEMPLATES.md) compares the templates, [docs/TUTORIAL.md](docs/TUTORIAL.md) builds a whole game step by step and [docs/COOKBOOK.md](docs/COOKBOOK.md) has recipes for rounds, teams, shops, projectiles, hidden information and more.

| Template | What it is |
| --- | --- |
| `blank` | the smallest complete game: walk, collect, score (~350 lines) — the default |
| `starter` | Crystal: co-op defense with waves, abilities, a boss, workers, RPC, admin commands |
| `duel` | Duel: turn-based artillery with seats, rounds, projectiles, destructible terrain, a bot opponent |

## Working as a team with AI

1. Everyone clones the repo and works on `main` with their AI tool (Claude Code, Codex, Cursor…). Instructions for the AI live in [AGENTS.md](AGENTS.md) and `games/<game>/AGENTS.md`.
2. New things in a game = a new directory `games/<game>/src/features/<your-id>/`. The registry finds it by itself.
3. `git pull --rebase && git push`. The server picks up the commit within 3 s, typechecks it, syncs it and reloads it live. A bad commit is reverted automatically and the game keeps running.

Example prompt:

> Read AGENTS.md and games/starter/AGENTS.md. Author: Ola. In games/starter/src/features/ola-swamp/ add a "Bog creature" enemy that slows players within 3 m, and a wave that summons it from wave 2. Add a custom 3D model in client.ts. Run npm run check and the tests. At the end tell me how to see it in the game.

## Layout

```text
packages/core/     @gaime/core — the engine (shared / server / client / kit / ui / three / audio / worker / vite)
packages/host/     @gaime/host — the `gaime` CLI: deploy supervisor, smoke, load, admin, new
games/blank/       minimal template
games/starter/     Crystal — co-op defense, the full-featured example
games/duel/        Duel — turn-based artillery
deploy/            Docker Compose, nginx gateway, Traefik/Caddy, systemd, backups, install.sh
docs/              guides and reference (docs/README.md)
.claude/skills/    playbooks for AI agents
```

Putting a game on a VPS (Docker, once):

```sh
sudo bash deploy/install.sh starter game.example.com git@github.com:org/repo.git --proxy traefik
```

From then on every push to `main` reaches the players by itself. Details, modes and operations: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).
