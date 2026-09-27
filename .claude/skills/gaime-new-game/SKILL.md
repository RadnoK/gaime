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
- What other people will add later with their AI — this becomes the **module kinds** (weapons, enemies, cards, maps, abilities, events). This is the most important design decision: it is the game's API.

## 2. Pick the template

| Template | Start from it when |
| --- | --- |
| `blank` | anything new; smallest code (move + collect + score), one module kind |
| `starter` (Crystal) | real-time top-down action: shooting, enemies with AI, waves, abilities with cooldowns, workers, bots |
| `duel` | turn-based or seat-based versus: match lifecycle (ready/countdown/result/rematch), turns, projectiles with gravity/wind, terrain, weapons |

```sh
npm run new-game -- <name> --title "Title" --from <template>
npm install
npm run dev -- <name>          # http://localhost:5173
```

`<name>` is permanent: it keys the room, the checkpoint and players' browser identities.

## 3. Reshape it, in this order

1. **`src/shared/types.ts`** — `World` (plain JSON only), `Player`, entities as `Record<id, Entity>`, `Input` (continuous: movement, aim), `Command` (discrete: fire, buy, ready), `Kinds` + definition types, `Sim` (the services module code gets).
2. **`src/shared/rules.ts`** — constants and pure functions shared by server and client (movement for prediction, geometry, terrain).
3. **`src/server/simulation.ts`** — `createWorld`, `createPlayer`, `prepareWorld` (catalog + cleanup of unknown module ids), `makeSim`, `step`, `command`. Reuse `@gaime/core/kit` instead of writing your own: `moveTopDown`, `raycast`, `separate`, `SpatialHash`, `launch`/`stepProjectiles`, `cooldown`/`every`/`status`, `createMatch`/`stepMatch`, `createTurns`/`nextTurn`, inventory, teams, random helpers, effects. Reference: `docs/KIT.md`.
4. **`src/server/registry.ts`** — `kinds: [...]` and a `validate` function per kind with clear error messages.
5. **`src/server/game.ts`** — `defineGame`: `keepPlayers`, `maxPlayers`, `network` (`entities` for every `Record<id, …>` that changes often, `streams: ['feed', 'effects']`, `shared: ['catalog']`, `hidden` for server-only state), `parseInput` (validate everything), `requests`, `chat.commands`, `admin` helpers (spawn/skip/heal — they make testing fast), `bot` if bots make sense.
6. **`src/features/*`** — 2–3 example modules per kind showing the range (a plain one, one with custom logic, one with a custom model).
7. **Client** — `src/client/main.ts` (keep: `keep(import.meta.hot, 'net', …)`, `Scope`, literal `import.meta.hot.accept()`), `GameUi` for lobby/chat/roster/menu, `Controls` bindings + `TouchControls`, `SoundBank`; `scene.ts` with `createStage`, `CameraRig` (`CAMERA.topDown` / `side` / `overhead`), `EntityLayer` per entity dictionary, `Interpolator` for others and prediction for yourself, `EffectsLayer`. See `docs/CLIENT.md`.
8. **Tests** — `tests/simulation.test.ts` with `testContext`: world creation, a full round, commands rejecting invalid use, a module loading. A bot-vs-bot run is a great end-to-end check for games with bots.
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

- Everything in `World` must be JSON: no Map/Set/Date/classes. Timers are world times.
- Never read `Math.random()`/`Date.now()` in simulation — use `ctx.random` and `world.time`.
- Side-view games: keep the plane x/z and treat z as "up"; map it in the renderer.
- Remove template leftovers (crystal, coins, weapons) instead of leaving dead code — the next AI will copy it.
- Keep the template's HMR/cleanup structure in `main.ts`, or client hot reload leaks canvases and listeners.
