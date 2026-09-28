# gaime documentation

## Start here

| | |
| --- | --- |
| [GETTING_STARTED.md](GETTING_STARTED.md) | install, run, first change, first game, first deploy |
| [TUTORIAL.md](TUTORIAL.md) | build a complete game ("Tag") from the blank template, step by step |
| [TEMPLATES.md](TEMPLATES.md) | the example games (`blank`, `starter`, `duel`, `bumper`) and which one to start from |
| [NEW_GAME.md](NEW_GAME.md) | creating a game, early design decisions, a starting prompt for your AI |

## The core guide

| | |
| --- | --- |
| [SIMULATION.md](SIMULATION.md) | **read this first when writing game rules or modules**: the one clock, the event bus, modifiers, timers, systems, module commands, the `Sim` facade, isolation, the spatial index, resources, module time budgets, determinism and replays, what keeps a game standing under load, `testGame` |

gaime does not decide what your game looks like or what players touch — lobby, HUD, scene, sounds and content are yours. What the framework guarantees is the mechanics underneath: a fixed-step clock, a deterministic event bus, persistent timers, ordered systems, module isolation and time budgets, and replayable sessions, so a game stays consistent when many people add features to it and keeps running under heavy traffic.

## Guides

| | |
| --- | --- |
| [ARCHITECTURE.md](ARCHITECTURE.md) | how the pieces fit: packages, the engine and the room (shared or matches), hot reload, one tick |
| [SERVER.md](SERVER.md) | `defineGame`, `GameContext`, commands, requests, client events, chat, bots, workers, persistence, rooms, replays, errors, admin |
| [MODULES.md](MODULES.md) | feature modules and the registry — definitions plus `on` / `modify` / `systems` / `commands`, isolation |
| [KIT.md](KIT.md) | the gameplay kit: collision, projectiles, cooldowns and statuses, rounds, turns, inventory, teams, randomness |
| [PHYSICS.md](PHYSICS.md) | `@gaime/physics`: rigid bodies (Rapier 2D) over plain-JSON entities — API, determinism, hot reload, performance, when not to use it |
| [COOKBOOK.md](COOKBOOK.md) | recipes: rounds, hitscan, projectiles, buffs as modifiers, spawning systems, delayed things with timers, rewards through events, module commands, teams, turns, shops, hidden info, bots… |
| [CLIENT.md](CLIENT.md) | `GameClient`, hot-reload-safe clients, controls, and the optional, replaceable defaults: `GameUi`, Three.js helpers, effects, audio |
| [PROTOCOL.md](PROTOCOL.md) | wire protocol, delta sync, network configuration, latency and load testing |
| [ROOMS.md](ROOMS.md) | one shared world or many matches: seats, matchmaking, invite codes, locking, lifetime, reconnection, admin, scaling out with Redis |
| [TESTING.md](TESTING.md) | `testGame` (the whole engine without a network), `testContext`, bot-vs-bot, record-and-replay determinism, smoke, load, the browser checklist |
| [DEPLOYMENT.md](DEPLOYMENT.md) | the supervisor, live/release modes, Docker, systemd, rollback, operations |
| [TROUBLESHOOTING.md](TROUBLESHOOTING.md) | symptoms → causes → fixes |
| [SKILLS.md](SKILLS.md) | the AI skills in `.claude/skills` and how to write new ones |

## Reference

| | |
| --- | --- |
| [reference/CONFIG.md](reference/CONFIG.md) | every option: `GameDefinition`, `GameContext`, world fields, module behaviour, engine limits, `testGame` and `replay`, `NetworkConfig`, the Vite plugin, `GameClient`, environment variables, HTTP endpoints |
| [reference/CLI.md](reference/CLI.md) | every `gaime` command and npm script |

## Per game

Every game has `games/<game>/AGENTS.md` (its rules and module API, for humans and AI) and `games/<game>/docs/ADDING_FEATURES.md` (a complete module example). The repository-wide rules for AI agents are in [../AGENTS.md](../AGENTS.md).
