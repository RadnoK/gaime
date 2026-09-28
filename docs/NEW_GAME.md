# A new game

```sh
npm run new-game -- super-popes --title "Popes vs Pops"       # from games/blank
npm run new-game -- arena --from starter                       # or from another game
npx gaime new --list                                           # available templates
npm install
npm run dev -- super-popes
```

This creates `games/super-popes` — a copy of the template with the new name (`defineGame({ name })`, `GameClient({ game })`, `package.json`, the title). It works right away: networking, HMR, checkpoints, chat, bots, tests, deploys, and the simulation model ([SIMULATION.md](SIMULATION.md)) — clock, events, modifiers, timers, systems, module isolation. Everything else you turn into your game — including everything players see: the template's lobby, HUD, scene and sounds are optional defaults, placeholders for your own design ([CLIENT.md](CLIENT.md)).

Which template: `blank` for anything new (small, nothing to delete), `starter` for real-time action with enemies and abilities, `duel` for versus games with seats, turns and projectiles — see [TEMPLATES.md](TEMPLATES.md). Any game in `games/` can be a template. For a guided walk-through, follow [TUTORIAL.md](TUTORIAL.md); for common mechanics, [COOKBOOK.md](COOKBOOK.md) and [KIT.md](KIT.md).

## What you usually change

| File | What |
| --- | --- |
| `src/shared/types.ts` | `World`, `Player`, entities, `Input`, `Command`, `Events`, `Modifiers`, `Sim`, module kinds (`Kinds`) |
| `src/shared/rules.ts` | constants, geometry, movement (shared with client prediction) |
| `src/server/simulation.ts` | `createWorld`, `createPlayer`, `makeSim` (the `Sim` for modules), `step`, systems, commands |
| `src/server/game.ts` | `defineGame`: `features`, `sim`, `systems`, `on`, `maxPlayers`, `keepPlayers`, `network` (incl. `events`), `requests`, `chat`, `admin` |
| `src/server/registry.ts` | the list of module kinds and their validation |
| `src/client/scene.ts` | camera, 3D world, models, effects |
| `src/client/main.ts`, `hud.ts`, `style.css` | the interface (your own, or `GameUi` + your widgets), controls, sounds |
| `src/features/*` | the game's starting content |
| `AGENTS.md`, `docs/ADDING_FEATURES.md` | instructions for AI: how to add content to **this** game |

Decisions worth making early:

- **Events and modifiers** — design them before the rules. `Events` are the facts of your game that others may react to (`enemy.died`, `round.ended`, `card.played`, in the past tense, with ids in the payload); `Modifiers` are the numbers others may adjust (`player.damage`, `card.cost`, `pickup.points`). Together with the module kinds they are your game's API: modules extend the game by listening and adjusting instead of editing the core. Declare both in `src/shared/types.ts` with a comment per entry, and trigger/modify them in exactly one place each (a `Sim` helper), as `games/blank` does.
- **Where the work goes** — input handling in `step`, per-tick rules in systems, periodic work in systems with `every`, delayed things as timers (`ctx.after`), reactions as `on` handlers ([SIMULATION.md](SIMULATION.md#where-things-go)).
- **Identity and seats**: `keepPlayers: true` (persistent characters, no player limit, e.g. a defense game) or `false` + `maxPlayers: 2` (a duel, seats freed on leave).
- **Turn-based or real time**: a turn-based game runs on the same clock (turn deadlines as timers or kit `turns`, actions as commands); the input is simply often empty.
- **2D / 2.5D / 3D**: simulate in the `x/z` plane — top-down games use it as the ground, side views (like `duel`) treat `z` as "up". The renderer decides the looks.
- **Hidden information**: card games, fog of war or secret roles need a per-player `view` ([SERVER.md](SERVER.md#per-player-views)).
- **Bots**: write the `bot` brain early — it makes solo testing and bot-vs-bot tests possible.
- **Module kinds**: what people will be adding (weapons, cards, maps, enemies, abilities) — with the events and modifiers, this is your game's API for AI.

## Starting prompt

```text
Use the gaime-new-game skill. Read AGENTS.md, docs/SIMULATION.md, docs/ARCHITECTURE.md,
docs/NEW_GAME.md, docs/KIT.md and the whole games/<name> directory.
Turn games/<name> into a game: [description — genre, camera, goal, number of players, controls,
and how it should look and feel].
Design first, in src/shared/types.ts: the World, the Events (facts others may react to), the
Modifiers (numbers others may adjust), the Sim (what module code may call) and the module
kinds (Kinds), so that other people can add content and behaviour in src/features/<id>/
without changing the core.
Build the rules on the engine: systems (with `every` for periodic work), timers (ctx.after)
for delayed things, events + `on` handlers for reactions, `modify` for adjustable numbers,
definition hooks run through sim.isolate. Use the kit (@gaime/core/kit) for collision,
cooldowns, statuses, rounds, turns and projectiles instead of writing your own.
Keep the framework mechanisms (GameClient, HMR, checkpoints, chat, module registry, bot brain);
the template's GameUi/scene/sounds are placeholders — keep, restyle or replace them to fit the game.
Rework the example modules (include one behaviour-only module), update the game's AGENTS.md and
docs/ADDING_FEATURES.md, and write testGame tests in tests/. Run npm run check and npm test.
```

## A separate repository per game?

Keeping many games in one repo is simplest (a shared framework, engine fixes reach every game at once, and `gaime` ignores commits that only touch other games). If a game should get its own repo: copy this whole repo and delete the other games from `games/` — the layout and deploys stay the same.
