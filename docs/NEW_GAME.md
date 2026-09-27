# A new game

```sh
npm run new-game -- super-popes --title "Popes vs Pops"       # from games/blank
npm run new-game -- arena --from starter                       # or from another game
npx gaime new --list                                           # available templates
npm install
npm run dev -- super-popes
```

This creates `games/super-popes` — a copy of the template with the new name (`defineGame({ name })`, `GameClient({ game })`, `package.json`, the title). It works right away: networking, HMR, checkpoints, chat, bots, tests, deploys. Everything else you turn into your game.

Which template: `blank` for anything new (small, nothing to delete), `starter` for real-time action with enemies and abilities, `duel` for versus games with seats, turns and projectiles — see [TEMPLATES.md](TEMPLATES.md). Any game in `games/` can be a template. For a guided walk-through, follow [TUTORIAL.md](TUTORIAL.md); for common mechanics, [COOKBOOK.md](COOKBOOK.md) and [KIT.md](KIT.md).

## What you usually change

| File | What |
| --- | --- |
| `src/shared/types.ts` | `World`, `Player`, entities, `Input`, `Command`, module kinds (`Kinds`) and `Sim` |
| `src/shared/rules.ts` | constants, geometry, movement (shared with client prediction) |
| `src/server/simulation.ts` | `createWorld`, `createPlayer`, `step`, commands, `Sim` for modules |
| `src/server/game.ts` | `defineGame`: `maxPlayers`, `keepPlayers`, `network`, `requests`, `chat`, `admin` |
| `src/server/registry.ts` | the list of module kinds and their validation |
| `src/client/scene.ts` | camera, 3D world, models, effects |
| `src/client/main.ts`, `hud.ts`, `style.css` | the interface (`GameUi` + your widgets), controls, sounds |
| `src/features/*` | the game's starting content |
| `AGENTS.md`, `docs/ADDING_FEATURES.md` | instructions for AI: how to add content to **this** game |

Decisions worth making early:

- **Identity and seats**: `keepPlayers: true` (persistent characters, no player limit, e.g. a defense game) or `false` + `maxPlayers: 2` (a duel, seats freed on leave).
- **Turn-based or real time**: a turn-based game still uses `step` (turn timers in `world`, actions in `command`); the input is simply often empty.
- **2D / 2.5D / 3D**: simulate in the `x/z` plane — top-down games use it as the ground, side views (like `duel`) treat `z` as "up". The renderer decides the looks.
- **Hidden information**: card games, fog of war or secret roles need a per-player `view` ([SERVER.md](SERVER.md#per-player-views)).
- **Bots**: write the `bot` brain early — it makes solo testing and bot-vs-bot tests possible.
- **Module kinds**: what people will be adding (weapons, cards, maps, enemies, abilities, events) — this is your game's API for AI.

## Starting prompt

```text
Use the gaime-new-game skill. Read AGENTS.md, docs/ARCHITECTURE.md, docs/NEW_GAME.md, docs/KIT.md
and the whole games/<name> directory.
Turn games/<name> into a game: [description — genre, camera, goal, number of players, controls].
Keep the framework mechanisms (GameClient, GameUi, HMR, checkpoints, chat, module registry, bot brain).
Use the kit (@gaime/core/kit) for collision, timers, rounds, turns and projectiles instead of writing your own.
Design the module kinds (Kinds) so that other people can add content in
src/features/<id>/ without changing the core; rework the example modules; update the game's
AGENTS.md and docs/ADDING_FEATURES.md and the tests in tests/. Run npm run check and npm test.
```

## A separate repository per game?

Keeping many games in one repo is simplest (a shared framework, engine fixes reach every game at once, and `gaime` ignores commits that only touch other games). If a game should get its own repo: copy this whole repo and delete the other games from `games/` — the layout and deploys stay the same.
