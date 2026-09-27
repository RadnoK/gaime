---
name: gaime-feature
description: Add new content to an existing gaime game as a feature module (a new enemy, ability, weapon, wave, pickup, boss, event…) in games/<game>/src/features/<id>/. Use whenever the user asks to add something to a game that fits the game's existing module kinds.
---

# Add a feature module to a gaime game

Content in gaime games lives in **modules**: `games/<game>/src/features/<id>/server.ts` (rules, runs on the server) and optionally `client.ts` (custom 3D models). The registry discovers them automatically; the dev server and the production host hot-reload them. Most requests ("add a boss", "add a teleport ability", "add a bouncing grenade") are one new directory and nothing else.

## 1. Orient (do not skip)

1. Identify the game (`games/starter` = Crystal, `games/duel` = Duel, `games/blank` = Blank, or another). Ask if unclear.
2. Read `games/<game>/AGENTS.md` and `games/<game>/docs/ADDING_FEATURES.md`.
3. Read `games/<game>/src/shared/types.ts`: the `Kinds` type lists the module kinds (e.g. `enemies`, `abilities`, `waves`, `weapons`, `pickups`) and their definition types; `Sim` lists what module code may call.
4. Look at one or two existing modules in `src/features/` of the same kind and copy their style.

If the idea does not fit any existing kind (e.g. "turrets" in a game without buildings), stop and use the `gaime-module-kind` skill first.

## 2. Write the module

- Directory name = module id: lowercase, digits, dashes, unique. Prefer `<author>-<idea>` (e.g. `ola-swamp`).
- Definition ids are **global and stable** (they are saved in checkpoints): prefix them too (`ola-bog`).
- `export default { author, description, <kind>: [...] } satisfies Feature;`
- Give every definition a player-facing `name` and `description` — they show up in the UI catalog (arsenal, weapon bar).
- State per entity goes into `entity.data['<module-id>-…']` / `player.data[...]` / `projectile.data[...]` — numbers, strings, booleans only. Never module-level variables, `setTimeout`, `Date.now()` or class instances: hot reload replaces modules and checkpoints only save the world.
- Time: `sim.world.time` and `sim.dt` (seconds). Periodic behaviour: `every(entity.data, '<id>-slam', world.time, 6)` from `@gaime/core/kit`, or compare against a stored "next at" time.
- Change the world through the game's `Sim` helpers (`hurtEnemy`, `explode`, `spawn`, `effect`, `emit`…) so scoring, deaths, effects and sounds stay consistent.
- Randomness: `sim.random()` (seedable in tests), never `Math.random()` in server code.
- Enemies need a way to appear: add or extend a wave/spawner in the same module.
- Custom looks: `visual: { shape: '<my-shape>', color }` + `client.ts` exporting `{ models: { '<my-shape>': visual => THREE.Object3D } }` (≈1 unit tall, standing on y = 0, facing +Z). Built-in shapes: box, sphere, capsule, cone, cylinder, torus, octahedron, ring. glTF files: put them in `games/<game>/public/models/` and register with `models.load(shape, '/models/x.glb')` in the game's client setup.
- Sounds/one-off client events: `sim.emit('sound', { kind })`; add the sound to the game's `SoundBank` in `src/client/main.ts` if it is new.

## 3. Heavy logic?

A tick has ~33 ms for everything. If the module needs pathfinding over a grid, big searches or procedural generation, use the `gaime-worker` skill (worker + `ctx.job`).

## 4. Verify

```sh
npm run check                               # typecheck (the server runs it as a deploy gate)
npm test                                    # existing tests must stay green
npx vitest run games/<game>                 # faster: only this game
```

Add a test to `games/<game>/tests/` for non-trivial logic (see existing tests; `testContext(world)` from `@gaime/core/server` gives a full context). Then, if a dev server runs: `cd games/<game> && npx gaime admin` lists helper commands (e.g. `npx gaime admin spawn <enemy-id> 3`, `npx gaime admin wave 3`).

## 5. Finish

- Commit only your files: `git add games/<game>/src/features/<id>` (+ test), `git commit -m "Add <what>"`, `git pull --rebase origin main`, `git push origin main`. Never force-push.
- Tell the user **where to see it**: which key/panel/wave/chat command, and any numbers worth tuning.

## Pitfalls

- Duplicate or renamed ids break old saves or fail the registry (the deploy is reverted automatically — the user sees "server code failed to load").
- Importing `server/*` from `client.ts` leaks server code into the browser bundle — client modules only import `three`, `@gaime/core/*` and `../../shared/*`.
- Do not edit other people's modules or central files to "register" yours — discovery is automatic.
- Do not add npm dependencies for a module (lockfile changes restart the game for everyone).

## Reference

`docs/MODULES.md` (module anatomy, registry, catalog, client models), `docs/KIT.md` (timers, status effects, projectiles, collision), `docs/COOKBOOK.md`.
