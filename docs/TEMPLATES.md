# Templates and examples

Every game in `games/` works as a template: `npm run new-game -- <name> --from <template>` copies it and renames the game key, title and package. `npx gaime new --list` shows what is available.

All templates run on the same simulation model ([SIMULATION.md](SIMULATION.md)) — fixed-step clock, event bus, modifiers, timers, systems, module isolation — and are tested with `testGame`. Their looks (HUD, scene, sounds) come from the framework's optional defaults and are placeholders: a new game replaces them with its own design.

| | `blank` | `starter` (Crystal) | `duel` | `bumper` |
| --- | --- | --- | --- | --- |
| Genre | walk & collect | co-op top-down shooter / tower defense | turn-based 1v1 artillery (Worms-like) | real-time physics sumo arena (push others off) |
| Camera | angled top-down | angled top-down, follows you | side view, frames both fighters and shells | top-down, the whole arena |
| Players | open, persistent characters | open (max 24), persistent characters | 2 seats + spectators, seats freed on leave | seats freed on leave, late joiners watch |
| Rooms | one shared world | one shared world | one shared world | **matches**: rooms of up to 6 players, public matchmaking and invite codes, the room locked while a round runs ([ROOMS.md](ROOMS.md)) |
| Session | endless | lobby → waves → loss → new round (host starts) | ready → countdown → round → result → rematch | ready → countdown → round (arena shrinks) → result → next round |
| Module kinds | `pickups` | `enemies`, `abilities`, `waves` | `weapons` | `powerups` |
| Engine mechanisms shown | `Events` + `on`, a `Modifiers` entry (`pickup.points`), a `Sim`, two systems (one periodic), a timer per pickup, a forwarded event, a definition hook run through `sim.isolate`, a behaviour-only module (`combo`) | see the game's `AGENTS.md` | see the game's `AGENTS.md` | physics as a system (`@gaime/physics`), contacts as bus events, `Modifiers` feeding physics (`push.mass`), a `Sim` with `push`/`knockOut`, a timer per respawn, `spatial` for bots, `rooms: matches` + `ctx.lockRoom`, a record-and-replay test starting mid-round, a behaviour-only module (`streak`) |
| Kit used | `moveTopDown`, `clampToRect`, `circlesOverlap`, `status`, `weighted`, `range`, `freeColor` | `raycast`, `separateWith`, `status`, `addEffect`, `pointOnCircle`, `weighted`, `freeColor` | `createMatch`/`stepMatch`, `createTurns`/`nextTurn`/`freezeTurn`, `launch`/`stepProjectiles`, `ballisticAngle`, `range` | `createMatch`/`stepMatch`, `cooldown`, `status`, `weighted`, `pointInRing`, `freeColor` |
| Server extras | bot brain | bot brain, worker pool (`/report`), RPC (`scoreboard`), chat command, admin commands (`spawn`, `wave`, `heal`), sound events | bot opponent (aims with `ballisticAngle`), seat hand-over from bots to humans, destructible terrain | bot brain (chase, dash when lined up, avoid the edge), knockout credit from contacts, lobby respawns |
| Client extras | `GameUi` + one widget, prediction, a sound on a forwarded event | `GameUi` + custom HUD, arsenal dialog, effects, custom module model (golem), gamepad/touch, sounds, screen shake | `GameUi` + turn/wind/power HUD, weapon bar, trajectory preview, terrain mesh, side-view effects | `GameUi` + round/dash widgets and banners, interpolated (not predicted) physics bodies, spin, falling discs, sounds + shake on bumps, gamepad/touch |
| Lines of game code | ~350 | ~1300 | ~900 | ~860 |

## Which one to start from

- **Something new** → `blank`. It is small enough to read in five minutes, and nothing needs deleting.
- **Real-time action with enemies/abilities** → `starter`; delete the crystal and waves you do not need.
- **Versus, seats, turns, rounds, projectiles** → `duel`.
- **Things that collide, bounce and tumble; short rounds in many small rooms** → `bumper` (rigid-body physics with `@gaime/physics`, [PHYSICS.md](PHYSICS.md); match rooms, [ROOMS.md](ROOMS.md)).

The room mode is independent of the template: `rooms: { mode: 'matches', size }` turns any of them into a match-based game, and removing it from Bumper gives one shared arena. Persistent worlds people drop in and out of → `shared`; sessions with a start and an end → `matches`.

A good first prompt for your AI is in [NEW_GAME.md](NEW_GAME.md); the whole process in `.claude/skills/gaime-new-game/SKILL.md`; a guided example in [TUTORIAL.md](TUTORIAL.md) (Tag, built from `blank`).

## What each template teaches

**blank** — the minimum, and the reference for the simulation model: `defineGame` with `network` (including `events`), `features`, `sim`, `parseInput`, `bot`; `Events` (`pickup.spawned`, `pickup.collected`, `pickup.expired`) and `Modifiers` (`pickup.points`) declared in `src/shared/types.ts`; a `Sim` facade built by `makeSim`; `step` for movement, a `collect` system and a periodic `spawn` system; scoring as an `on` handler; an expiry timer per pickup, cancelled on collection; a definition hook (`onPickup`) run through `sim.isolate`; a behaviour-only module (`features/combo`: an `on` handler plus a modifier); client with `keep`/`Scope`/`GameUi`/`Controls`/`TouchControls` and a sound on a forwarded event; scene with `CameraRig`, `EntityLayer`, `ModelLibrary`, interpolation and prediction; `testGame` tests including a bot.

**starter** — a complete co-op game: a `Sim` interface for module code (`hurtEnemy`, `spawn`, `slow`, `effect`, `emit`, `defaultAi`…); hitscan with `raycast`; crowd separation; slows with `status`; waves chosen by weight; abilities with cooldowns bound to Q/E; the catalog shown in an arsenal dialog; a boss with its own AI and custom model; a worker pool for analysis used from a chat command via `ctx.job`; RPC; admin commands; bots that defend the crystal.

**duel** — a complete versus game: the match lifecycle with ready/rematch; turns with a frozen clock while shells fly and a retreat phase; wind rerolled per turn; ballistic projectiles with per-weapon gravity/wind; terrain as a height field with craters; players falling into craters; weapons as data plus an `onImpact` hook (cluster bomb spawning bomblets); spectators; a bot that plays whole rounds; a bot-vs-bot test.

**bumper** — a physics game: `@gaime/physics` (Rapier 2D) stepping plain-JSON discs as a system; steering and dashes written as velocity changes the physics picks up; contacts arriving as `physics.contact` events that credit knockouts; a `push.mass` modifier feeding each disc's density (the `anvil` powerup); powerups as a module kind with statuses and an isolated `onCollect` hook; the kit match lifecycle with a shrinking arena so rounds end; match rooms of 6 (`rooms: { mode: 'matches', size: 6 }`) locked with `ctx.lockRoom` while a round runs; bots that chase, line up and dash (`ctx.nearest` on the spatial index); deterministic, replay and hot-reload tests.
