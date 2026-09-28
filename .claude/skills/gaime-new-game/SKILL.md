---
name: gaime-new-game
description: Create a new multiplayer game in the gaime monorepo from a template (blank, starter, duel) and reshape it into the requested genre — world model, rules, module kinds, client and docs. Use when the user wants a new game, a prototype of a game idea, or a new genre on the framework.
---

# Create a new gaime game

## 1. Understand the game before generating files

Pin down (ask briefly if the request is vague):

- Genre and camera: top-down arena, side view, overhead board, third person…
- Real time or turn-based; rounds/matches or a persistent world.
- Players: co-op or versus, seats (e.g. exactly 2) or open (anyone joins any time), spectators, bots.
- What other people will add later with their AI — this becomes the **module kinds** (weapons, enemies, cards, maps, abilities) plus the **events** they react to and the **modifiers** they adjust. This is the most important design decision: it is the game's API.
- How it should look and feel — the template's HUD, scene and sounds are placeholders; the game's authors decide what players see.

## 2. Pick the template

| Template | Start from it when |
| --- | --- |
| `blank` | anything new; smallest code (move + collect + score), one module kind; the reference for events, modifiers, timers, systems and a behaviour-only module |
| `starter` (Crystal) | real-time top-down action: shooting, enemies with AI, waves, abilities with cooldowns, workers, bots |
| `duel` | turn-based or seat-based versus: match lifecycle (ready/countdown/result/rematch), turns, projectiles with gravity/wind, terrain, weapons |

```sh
npm run new-game -- <name> --title "Title" --from <template>
npm install
npm run dev -- <name>          # http://localhost:5173
```

`<name>` is permanent: it keys the room, the checkpoint and players' browser identities.

## 3. Reshape it, in this order

Read `docs/SIMULATION.md` first, then:

1. **`src/shared/types.ts`** — design the API before the rules: `World` (plain JSON only), `Player`, entities as `Record<id, Entity>`, `Input` (continuous: movement, aim), `Command` (discrete: fire, buy, ready); **`Events`** (facts others react to, past tense, ids in payloads: `'enemy.died'`, `'round.ended'`), **`Modifiers`** (numbers others adjust: `'player.damage'`, `'card.cost'` — never values the client predicts), **`Sim`** (the services module code gets: `world`, `dt`, `random`, `trigger`, `after`, `cancel`, `modify`, `emit`, `isolate`, plus game helpers like `hurtEnemy`), `Kinds` + definition types, `Feature = FeatureModule<Kinds, Sim, Events, Modifiers>`. Comment every event and modifier.
2. **`src/shared/rules.ts`** — constants and pure functions shared by server and client (movement for prediction, geometry, terrain, anything the client predicts).
3. **`src/server/simulation.ts`** — `createWorld`, `createPlayer`, `prepareWorld` (catalog + cleanup of unknown module ids), `makeSim` (trigger each event and compute each modifier in exactly one helper), `step` for inputs, system functions, `command`. Periodic work → systems with `every`; delays → timers (`ctx.after(…, { key })`); reactions → `on`; definition hooks → `sim.isolate(registry.owner['<kind>/<id>'], …)`. Reuse `@gaime/core/kit`: `moveTopDown`, `raycast`, `separate`, `SpatialHash`, `launch`/`stepProjectiles`, `cooldown`/`status`, `createMatch`/`stepMatch`, `createTurns`/`nextTurn`, inventory, teams, random helpers, effects. Reference: `docs/KIT.md`.
4. **`src/server/registry.ts`** — `kinds: [...]` and a `validate` function per kind with clear error messages.
5. **`src/server/game.ts`** — `defineGame<World, Input, Sim, Events, Modifiers>`: `features: registry`, `sim`, `systems`, `on`, `keepPlayers`, `maxPlayers`, `network` (`entities` for every `Record<id, …>` that changes often, `streams: ['feed', 'effects']`, `shared: ['catalog']`, `hidden` for server-only state, `events` for bus events clients play sounds/effects for), `parseInput` (validate everything), `requests`, `chat.commands`, `admin` helpers (spawn/skip/heal — they make testing fast), `bot` if bots make sense.
6. **`src/features/*`** — 2–3 example modules per kind showing the range (a plain one, one with custom logic, one with a custom model), plus one behaviour-only module (`on` / `modify`, like `games/blank/src/features/combo`).
7. **Client** — `src/client/main.ts` (keep: `keep(import.meta.hot, 'net', …)`, `Scope`, literal `import.meta.hot.accept()`), `GameClient<World, Input, Command, Events>` with `net.onEvent` for forwarded events, `Controls` bindings + `TouchControls`. The look is the game's own: the template's `GameUi`, Three.js scene (`createStage`, `CameraRig`, `EntityLayer`, `Interpolator`, `EffectsLayer`) and `SoundBank` are optional defaults — keep them as placeholders, restyle them, or replace them with what the user describes. See `docs/CLIENT.md`.
8. **Tests** — `tests/simulation.test.ts` with `testGame(game, { random: seeded(1) })`: a full round, events and timers (`t.triggeredOf`, `t.ctx.timeLeft`), commands rejecting invalid use, every module loading and doing what it promises, a bot-vs-bot run (`t.addBot()` twice, `t.run(seconds, until)`).
9. **Docs for the next AI** — rewrite `games/<name>/AGENTS.md` (coordinates, flow, files) and `docs/ADDING_FEATURES.md` (a prompt to paste + one complete module per kind). Keep `CLAUDE.md` as `@AGENTS.md`.

## 4. Verify

```sh
npm run check && npx vitest run games/<name>
npm run dev -- <name>                       # play it; /bot in chat if you added a bot brain
cd games/<name> && npx gaime smoke          # real WebSocket clients against the dev server
npm run build -w games/<name>               # production build works
```

## 5. Ship

Commit `games/<name>` and `package-lock.json`, push to `main`. Hosting it is a separate step (`gaime-deploy` skill; `deploy/install.sh <name> <domain> <repo>`).

## Pitfalls

- Everything in `World` must be JSON: no Map/Set/Date/classes. Time is `world.time`; delays are engine timers, not countdown fields.
- Modules calling each other or the core polling for changes — design events and modifiers instead.
- Never read `Math.random()`/`Date.now()` in simulation — use `ctx.random` and `world.time`.
- Side-view games: keep the plane x/z and treat z as "up"; map it in the renderer.
- Remove template leftovers (crystal, coins, weapons) instead of leaving dead code — the next AI will copy it.
- Keep the template's HMR/cleanup structure in `main.ts`, or client hot reload leaks canvases and listeners.

## Reference

`docs/SIMULATION.md`, `docs/TEMPLATES.md`, `docs/TUTORIAL.md` (a whole game built from blank), `docs/NEW_GAME.md`, `docs/COOKBOOK.md`, `docs/SERVER.md`.
