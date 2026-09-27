# gaime documentation

## Start here

| | |
| --- | --- |
| [GETTING_STARTED.md](GETTING_STARTED.md) | install, run, first change, first game, first deploy |
| [TUTORIAL.md](TUTORIAL.md) | build a complete game ("Tag") from the blank template, step by step |
| [TEMPLATES.md](TEMPLATES.md) | the example games (`blank`, `starter`, `duel`) and which one to start from |
| [NEW_GAME.md](NEW_GAME.md) | creating a game, early design decisions, a starting prompt for your AI |

## Guides

| | |
| --- | --- |
| [ARCHITECTURE.md](ARCHITECTURE.md) | how the pieces fit: packages, the room, hot reload, one tick |
| [SERVER.md](SERVER.md) | `defineGame`, the simulation, commands, requests, events, chat, bots, workers, persistence, admin |
| [CLIENT.md](CLIENT.md) | `GameClient`, hot-reload-safe clients, controls, `GameUi`, Three.js helpers, effects, audio |
| [KIT.md](KIT.md) | the gameplay kit: collision, projectiles, timers, rounds, turns, inventory, teams, randomness |
| [MODULES.md](MODULES.md) | feature modules and the registry — how content is added without touching the core |
| [COOKBOOK.md](COOKBOOK.md) | recipes: rounds, hitscan, projectiles, buffs, spawning, teams, turns, shops, hidden info, bots… |
| [PROTOCOL.md](PROTOCOL.md) | wire protocol, delta sync, network configuration, latency and load testing |
| [TESTING.md](TESTING.md) | logic tests, bot-vs-bot, smoke, load, the browser checklist |
| [DEPLOYMENT.md](DEPLOYMENT.md) | the supervisor, live/release modes, Docker, systemd, rollback, operations |
| [TROUBLESHOOTING.md](TROUBLESHOOTING.md) | symptoms → causes → fixes |
| [SKILLS.md](SKILLS.md) | the AI skills in `.claude/skills` and how to write new ones |

## Reference

| | |
| --- | --- |
| [reference/CONFIG.md](reference/CONFIG.md) | every option: `GameDefinition`, `NetworkConfig`, the Vite plugin, `GameClient`, environment variables, HTTP endpoints |
| [reference/CLI.md](reference/CLI.md) | every `gaime` command and npm script |

## Per game

Every game has `games/<game>/AGENTS.md` (its rules and module API, for humans and AI) and `games/<game>/docs/ADDING_FEATURES.md` (a complete module example). The repository-wide rules for AI agents are in [../AGENTS.md](../AGENTS.md).
