# A new game

```sh
npm run new-game -- super-popes --title "Popes vs Pops"
npm install
npm run dev -- super-popes
```

This creates `games/super-popes` — a copy of `games/starter` with the new name (`defineGame({ name })`, `GameClient({ game })`, `package.json`, the title). It works right away: networking, HMR, checkpoints, chat, tests, deploys. Everything else you turn into your game.

## What you usually change

| File | What |
| --- | --- |
| `src/shared/types.ts` | `World`, `Player`, entities, `Input`, `Command`, module kinds (`Kinds`) and `Sim` |
| `src/shared/rules.ts` | constants, geometry, movement (shared with client prediction) |
| `src/server/simulation.ts` | `createWorld`, `createPlayer`, `step`, commands, `Sim` for modules |
| `src/server/game.ts` | `defineGame`: `maxPlayers`, `keepPlayers`, `network`, `requests`, `chat`, `admin` |
| `src/server/registry.ts` | the list of module kinds and their validation |
| `src/client/scene.ts` | camera, 3D world, models, effects |
| `src/client/hud.ts`, `style.css` | the interface |
| `src/features/*` | the game's starting content |
| `AGENTS.md`, `docs/ADDING_FEATURES.md` | instructions for AI: how to add content to **this** game |

Decisions worth making early:

- **Identity and seats**: `keepPlayers: true` (persistent characters, no player limit, e.g. a defense game) or `false` + `maxPlayers: 2` (a duel, seats freed on leave).
- **Turn-based or real time**: a turn-based game still uses `step` (turn timers in `world`, actions in `command`); the input is simply often empty.
- **2D / 2.5D / 3D**: simulate in the `x/z` plane (or `x/y` for a side camera) — the renderer decides the looks.
- **Module kinds**: what people will be adding (weapons, cards, maps, enemies, abilities, events) — this is your game's API for AI.

## Starting prompt

```text
Read AGENTS.md, docs/ARCHITECTURE.md, docs/NEW_GAME.md and the whole games/<name> directory.
Turn games/<name> into a game: [description — genre, camera, goal, number of players, controls].
Keep the framework mechanisms (GameClient, HMR, checkpoints, chat, module registry).
Design the module kinds (Kinds) so that other people can add content in
src/features/<id>/ without changing the core; rework the example modules; update the game's
AGENTS.md and docs/ADDING_FEATURES.md and the tests in tests/. Run npm run check and npm test.
```

## A separate repository per game?

Keeping many games in one repo is simplest (a shared framework, engine fixes reach every game at once, and `gaime` ignores commits that only touch other games). If a game should get its own repo: copy this whole repo and delete the other games from `games/` — the layout and deploys stay the same.
