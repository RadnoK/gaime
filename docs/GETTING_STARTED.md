# Getting started

From a fresh clone to your own change running live, in about fifteen minutes.

## 1. Install and run

Requirements: **Node.js ≥ 22.12**, npm, git.

```sh
git clone <repo> gaime && cd gaime
npm install
npm run dev                 # Crystal (games/starter) at http://localhost:5173
npm run dev -- duel         # or any other game in games/
```

Open the address, pick a nickname, play. Useful right away:

| | |
| --- | --- |
| `?player=2` | a second player in another tab (separate identity) |
| `?lag=150&jitter=40&loss=5` | a bad network, simulated in the browser |
| F3 | network stats: ping, patches per second, bytes |
| Enter / `/help` | chat and its commands; the first player is the host 👑 |
| `/bot` (host) | add a bot player; `/bot remove` removes them |

Everything hot-reloads: change a file in `games/starter/src/` while playing and watch it apply without a page reload — server code included, the world and players stay.

## 2. Look around

```text
packages/core/      the engine — @gaime/core, @gaime/core/{server,client,three,kit,ui,audio,worker,vite}
packages/host/      the gaime CLI: deploy supervisor, smoke/load tests, admin, `gaime new`
packages/physics/   @gaime/physics: optional rigid-body physics (Rapier 2D)
games/blank/        the smallest complete game — the default template
games/starter/      Crystal: a co-op defense game with most features in use
games/duel/         Duel: turn-based artillery with seats, rounds, projectiles
games/bumper/       Bumper: a physics sumo arena (@gaime/physics), rounds, bots
deploy/             Docker Compose, nginx gateway, Traefik/Caddy, systemd, backups
docs/               this documentation
.claude/skills/     playbooks for AI agents (docs/SKILLS.md)
```

A game is four folders: `src/shared` (types, events and rules used by both sides), `src/server` (the simulation), `src/client` (rendering and HUD), `src/features/*` (content and behaviour modules). [ARCHITECTURE.md](ARCHITECTURE.md) explains how they fit together.

Every game runs on the same **simulation model** ([SIMULATION.md](SIMULATION.md)): one fixed-step clock (`world.time`), an event bus (`ctx.trigger` + `on` handlers), modifiers for numbers several modules adjust, persistent timers (`ctx.after`), and systems for per-tick and periodic work. Modules plug into those instead of into each other, which is what keeps a game consistent when many people add to it and keeps it standing under load. Read it before writing rules.

What players see — lobby, HUD, scene, sounds — is up to each game. The templates use the framework's optional defaults (`GameUi`, the Three.js helpers, `SoundBank`) so they work out of the box; replace them whenever your game has its own look ([CLIENT.md](CLIENT.md)).


## 3. Make a change

Add a module to Crystal — a new enemy — by hand or by asking your AI:

```text
Read AGENTS.md and games/starter/AGENTS.md. In games/starter/src/features/my-beetles/ add a fast,
weak "Scuttler" enemy and a wave that sends 12 of them from wave 2. Use the gaime-feature skill.
```

It is one new directory (`src/features/my-beetles/server.ts`); the game picks it up while running. A module can also add behaviour without new content — react to the game's events, adjust its values, run its own systems, add a command ([MODULES.md](MODULES.md)); `games/blank/src/features/combo/` is a ten-line example. Then:

```sh
npm run check               # typecheck — the server runs this before deploying anything
npm test                    # logic tests of the framework and every game
```

## 4. Make your own game

```sh
npm run new-game -- hive --title "Hive"          # from games/blank; --from starter|duel for the others
npm install
npm run dev -- hive
```

Then follow [TUTORIAL.md](TUTORIAL.md) (builds "Tag" from blank step by step) or give your AI the prompt in [NEW_GAME.md](NEW_GAME.md). [TEMPLATES.md](TEMPLATES.md) helps you choose a template; [COOKBOOK.md](COOKBOOK.md) has recipes for rounds, teams, shops, projectiles and more.

## 5. Put it online

Follow [QUICK_DEPLOY.md](QUICK_DEPLOY.md) to invite the team, prepare a Docker VPS, install the game, and check its public URL. It covers public and private GitHub repositories and works with a real domain or a trial `sslip.io` address.

From then on `git push` to `main` is the deploy: the server picks the commit up within seconds, typechecks it, hot-reloads it without kicking anyone, and reverts it by itself if it breaks. [DEPLOYMENT.md](DEPLOYMENT.md) covers modes, rollback and operations. Without a server: `cd games/hive && npx gaime host` runs the same supervisor on your laptop (share it over LAN/Tailscale).

## 6. Working as a team

- Everyone works on `main` with their own AI; content goes into their own `src/features/<name>-…` directories, so pushes rarely conflict.
- `git pull --rebase && git push`. Never force-push.
- Rules the AI must follow are in [AGENTS.md](../AGENTS.md) — the short version: the server is authoritative, all state lives in the plain-JSON world, modules talk through events, modifiers, timers and systems (never through each other's code), ids are stable, check before you push.

## Where next

| I want to… | Read |
| --- | --- |
| understand the whole system | [ARCHITECTURE.md](ARCHITECTURE.md) |
| understand the simulation model (clock, events, modifiers, timers, systems) | [SIMULATION.md](SIMULATION.md) |
| write game rules | [SERVER.md](SERVER.md), [KIT.md](KIT.md), [COOKBOOK.md](COOKBOOK.md) |
| build the UI and 3D scene | [CLIENT.md](CLIENT.md) |
| add content modules | [MODULES.md](MODULES.md) |
| tune networking | [PROTOCOL.md](PROTOCOL.md) |
| test (`testGame`: the real engine without a network) | [TESTING.md](TESTING.md) |
| fix something | [TROUBLESHOOTING.md](TROUBLESHOOTING.md) |
| look up an option | [reference/CONFIG.md](reference/CONFIG.md), [reference/CLI.md](reference/CLI.md) |
