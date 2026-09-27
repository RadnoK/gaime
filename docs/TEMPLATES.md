# Templates and examples

Every game in `games/` works as a template: `npm run new-game -- <name> --from <template>` copies it and renames the game key, title and package. `npx gaime new --list` shows what is available.

| | `blank` | `starter` (Crystal) | `duel` |
| --- | --- | --- | --- |
| Genre | walk & collect | co-op top-down shooter / tower defense | turn-based 1v1 artillery (Worms-like) |
| Camera | angled top-down | angled top-down, follows you | side view, frames both fighters and shells |
| Players | open, persistent characters | open (max 24), persistent characters | 2 seats + spectators, seats freed on leave |
| Session | endless | lobby → waves → loss → new round (host starts) | ready → countdown → round → result → rematch |
| Module kinds | `pickups` | `enemies`, `abilities`, `waves` | `weapons` |
| Kit used | `moveTopDown`, `clampToRect`, `circlesOverlap`, `every`, `weighted` | `raycast`, `separate`, `status`, `addEffect`, `pointOnCircle`, `weighted`, `freeColor` | `createMatch`/`stepMatch`, `createTurns`/`nextTurn`/`freezeTurn`, `launch`/`stepProjectiles`, `ballisticAngle`, `range` |
| Server extras | bot brain | bot brain, worker pool (`/report`), RPC (`scoreboard`), chat command, admin commands (`spawn`, `wave`, `heal`), sound events | bot opponent (aims with `ballisticAngle`), seat hand-over from bots to humans, destructible terrain |
| Client extras | `GameUi` + one widget, prediction | `GameUi` + custom HUD, arsenal dialog, effects, custom module model (golem), gamepad/touch, sounds, screen shake | `GameUi` + turn/wind/power HUD, weapon bar, trajectory preview, terrain mesh, side-view effects |
| Lines of game code | ~350 | ~1300 | ~900 |

## Which one to start from

- **Something new** → `blank`. It is small enough to read in five minutes, and nothing needs deleting.
- **Real-time action with enemies/abilities** → `starter`; delete the crystal and waves you do not need.
- **Versus, seats, turns, rounds, projectiles** → `duel`.

A good first prompt for your AI is in [NEW_GAME.md](NEW_GAME.md); the whole process in `.claude/skills/gaime-new-game/SKILL.md`; a guided example in [TUTORIAL.md](TUTORIAL.md) (Tag, built from `blank`).

## What each template teaches

**blank** — the minimum: `defineGame` with `network`, `parseInput`, `bot`; a registry with one kind and validation; `every` for spawning with state in `world.timers` (hidden from clients); client with `keep`/`Scope`/`GameUi`/`Controls`/`TouchControls`; scene with `CameraRig`, `EntityLayer`, `ModelLibrary`, interpolation and prediction; a logic test with `testContext`.

**starter** — a complete co-op game: a `Sim` interface for module code (`hurtEnemy`, `spawn`, `slow`, `effect`, `emit`, `defaultAi`…); hitscan with `raycast`; crowd separation; slows with `status`; waves chosen by weight; abilities with cooldowns bound to Q/E; the catalog shown in an arsenal dialog; a boss with its own AI and custom model; a worker pool for analysis used from a chat command via `ctx.job`; RPC; admin commands; bots that defend the crystal.

**duel** — a complete versus game: the match lifecycle with ready/rematch; turns with a frozen clock while shells fly and a retreat phase; wind rerolled per turn; ballistic projectiles with per-weapon gravity/wind; terrain as a height field with craters; players falling into craters; weapons as data plus an `onImpact` hook (cluster bomb spawning bomblets); spectators; a bot that plays whole rounds; a bot-vs-bot test.
