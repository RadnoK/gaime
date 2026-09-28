---
name: gaime-feature
description: Add new content or behaviour to an existing gaime game as a feature module (a new enemy, ability, weapon, wave, pickup, boss, a rule that reacts to game events, a bonus, a new player action…) in games/<game>/src/features/<id>/. Use whenever the user asks to add something to a game that fits the game's existing module kinds, events and modifiers.
---

# Add a feature module to a gaime game

Content and behaviour in gaime games live in **modules**: `games/<game>/src/features/<id>/server.ts` (runs on the server) and optionally `client.ts` (custom 3D models). A module can contribute **definitions** (entries of the game's module kinds) and **behaviour**: `on` (react to the game's events), `modify` (adjust the game's values), `systems` (per-tick or periodic work), `commands` (new player actions). The registry discovers modules automatically; the dev server and the production host hot-reload them. Most requests ("add a boss", "add a teleport ability", "kills give gold", "double points at night") are one new directory and nothing else.

## 1. Orient (do not skip)

1. Identify the game (`games/starter` = Crystal, `games/duel` = Duel, `games/blank` = Blank, or another). Ask if unclear.
2. Read `games/<game>/AGENTS.md` and `games/<game>/docs/ADDING_FEATURES.md`.
3. Read `games/<game>/src/shared/types.ts`: `Kinds` lists the module kinds (e.g. `enemies`, `abilities`, `waves`, `weapons`, `pickups`) and their definition types; `Events` lists what happens in the game (what you can react to with `on`); `Modifiers` lists the values you can adjust with `modify`; `Sim` lists what module code may call.
4. Read `docs/SIMULATION.md` once (where things go: systems, timers, events, modifiers, commands).
5. Look at one or two existing modules in `src/features/` of the same kind and copy their style (`games/blank/src/features/combo/` is a behaviour-only example).

If the idea needs a new kind of content (e.g. "turrets" in a game without buildings), stop and use the `gaime-module-kind` skill first. If it needs an event or modifier the game does not have yet (e.g. no `enemy.died` event), add it in the game's core with the `gaime-mechanic` skill — never patch around it from the module.

## 2. Write the module

- Directory name = module id: lowercase, digits, dashes, unique. Prefer `<author>-<idea>` (e.g. `ola-swamp`).
- Definition ids are **global and stable** (they are saved in checkpoints): prefix them too (`ola-bog`).
- `export default { author, description, <kind>: [...] } satisfies Feature;`
- Give every definition a player-facing `name` and `description` — they show up in the UI catalog (arsenal, weapon bar).
- State per entity goes into `entity.data['<module-id>-…']` / `player.data[...]` / `projectile.data[...]` — numbers, strings, booleans only. Never module-level variables, `setTimeout`, `Date.now()` or class instances: hot reload replaces modules and checkpoints only save the world.
- Time: `sim.world.time` and `sim.dt` (seconds).
- Pick the mechanism by what the feature does:

  | The feature… | Use in the module |
  | --- | --- |
  | reacts to something that happens (kill, pickup, round end) | `on: { 'enemy.died': (e, sim) => … }` |
  | changes a number the game computes (damage, speed, points, price) | `modify: { 'player.damage': (value, data, sim) => … }` (return the new value) |
  | does work every tick or every N seconds (aura, spawner, regeneration) | `systems: [{ id: 'aura', every: 0.5, run: (sim, dt) => … }]` |
  | does something once, later (fuse, delayed burst, expiry) | a timer for a private event (`sim.after(3, 'ola-swamp:burst', { enemy: id }, …)` or `ctx.after`, keyed `ola-swamp:<id>`) + an `on` handler for it |
  | gives players a new action | `commands: { '<module-id>-dash': (playerId, command, sim) => … }` — validate everything, return a string to refuse |
  | a timed state other code reads (slow, shield, cooldown) | kit `status` / `cooldown` in `entity.data` |

- Names are global: command types are `<module>-<action>` (`ola-swamp-dive`); events only your module uses are **private** — `<module>:<event>` (`ola-swamp:burst`) — and need no entry in the game's `Events` (payload untyped: validate it). Events other modules may react to belong in the game's `Events` (`gaime-mechanic`). Pass ids in payloads and check the entity still exists in handlers.
- React to players with the engine events `player.joined` / `player.online` / `player.offline` / `player.removed` (`{ player }`) instead of asking for new hooks.
- Modifiers run on the server only: never use them for values the client predicts (movement speed, collision size).
- Change the world through the game's `Sim` helpers (`hurtEnemy`, `explode`, `spawn`, `spawnPickup`, `effect`, `emit`…) so scoring, deaths, events, effects and sounds stay consistent. Never call another module's code.
- Randomness: `sim.random()` (seedable in tests), never `Math.random()` in server code.
- Enemies need a way to appear: add or extend a wave/spawner in the same module.
- Custom looks: `visual: { shape: '<my-shape>', color }` + `client.ts` exporting `{ models: { '<my-shape>': visual => THREE.Object3D } }` (≈1 unit tall, standing on y = 0, facing +Z). Built-in shapes: box, sphere, capsule, cone, cylinder, torus, octahedron, ring. glTF files: put them in `games/<game>/public/models/` and register with `models.load(shape, '/models/x.glb')` in the game's client setup.
- Sounds/one-off client events: `sim.emit('sound', { kind })`, or rely on a bus event the game forwards (`network.events`); add the sound to the game's client (`src/client/main.ts`) if it is new.

## 3. Heavy logic?

A tick has ~33 ms for everything. Prefer `every` on systems over per-tick work, iterate only what you need (`SpatialHash`). If the module needs pathfinding over a grid, big searches or procedural generation, use the `gaime-worker` skill (worker + `ctx.job`).

## 4. Verify

```sh
npm run check                               # typecheck (the server runs it as a deploy gate)
npm test                                    # existing tests must stay green
npx vitest run games/<game>                 # faster: only this game
```

Add a test to `games/<game>/tests/` for non-trivial logic with `testGame(game, { random: seeded(1) })` from `@gaime/core/server` — the real engine, strict about errors, so a throwing handler fails the test:

```ts
const t = testGame(game, { random: seeded(1) });
const ada = t.join('Ada');
t.run(5);                                          // or t.act(sim => sim.spawnPickup('coin', t.player(ada))); t.tick();
expect(t.triggeredOf('enemy.died')).toHaveLength(1);
expect(t.command(ada, { type: 'ola-dash' })).toBeUndefined();
```

Then, if a dev server runs: `cd games/<game> && npx gaime admin` lists helper commands (e.g. `npx gaime admin spawn <enemy-id> 3`, `npx gaime admin wave 3`).

## 5. Finish

- Commit only your files: `git add games/<game>/src/features/<id>` (+ test), `git commit -m "Add <what>"`, `git pull --rebase origin main`, `git push origin main`. Never force-push.
- Tell the user **where to see it**: which key/panel/wave/chat command, and any numbers worth tuning.

## Checklist

- [ ] One new directory; nothing edited outside it (except a test).
- [ ] Ids (module, definitions, systems, commands, own events, timer keys) prefixed and stable.
- [ ] No module-level state, `setTimeout`, `Date.now()`, `Math.random()`.
- [ ] Reactions via `on`, adjustments via `modify`, periodic work via systems with `every`, delays via timers — no polling, no calls into other modules.
- [ ] Client values in `commands` validated; refusals returned as strings.
- [ ] Every definition has `name` and `description`; content has a way to appear (a wave, a spawner).
- [ ] `npm run check` and the game's tests pass.

## Pitfalls

- Duplicate or renamed ids break old saves or fail the registry (the deploy is reverted automatically — the user sees "server code failed to load").
- Importing `server/*` from `client.ts` leaks server code into the browser bundle — client modules only import `three`, `@gaime/core/*` and `../../shared/*`.
- Do not edit other people's modules or central files to "register" yours — discovery is automatic.
- A handler that triggers the event it handles is an event storm: the engine switches the module off.
- A module that throws live is switched off (⚠ in the feed, `disabled` in `/health`), not the whole game — but its feature is gone until a fix is pushed.
- Do not add npm dependencies for a module (lockfile changes restart the game for everyone).

## Reference

`docs/SIMULATION.md` (the model), `docs/MODULES.md` (module anatomy, behaviour keys, isolation, registry, catalog, client models), `docs/KIT.md` (status effects, cooldowns, projectiles, collision), `docs/COOKBOOK.md` (events, modifiers, timers, module commands).
