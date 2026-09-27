---
name: gaime-mechanic
description: Implement or change a core gameplay mechanic in a gaime game — new world state, simulation rules, commands, player stats, rounds, scoring, physics — safely for live players and saved games (hydrate, migrations, HMR). Use for changes to a game's src/shared or src/server beyond adding a module.
---

# Change game mechanics safely

The game runs live while you edit it: every push is hot-reloaded into a running room that keeps its world. Your change must work on the **existing** world, not only on a fresh one.

## 1. Where the change goes

| Change | File |
| --- | --- |
| New/changed world or player fields | `src/shared/types.ts` + defaults in `createWorld()` / `createPlayer()` |
| Rules shared with client prediction (movement, geometry) | `src/shared/rules.ts` |
| What happens every tick | `step()` in `src/server/simulation.ts` |
| A player action | a `Command` variant + `command()`; the client sends `net.command({...})` |
| Continuous control (movement, aim) | `Input` + `parseInput` in `game.ts` |
| Something modules should be able to do | a method on `Sim` |
| Query from the client (ranking, shop list) | `requests` in `defineGame` → `net.request(name)` |
| One-off client feedback (sound, shake) | `ctx.emit(name, data)` → `net.on('event', …)` |

## 2. State rules

- JSON only; ids as `Record<string, T>` keys; times as `world.time` values (`respawnAt`, `nextShotAt`).
- New fields: add them to `createWorld()`/`createPlayer()` — older saves and the hot-reloaded world get the defaults automatically (`hydrate`). No migration needed.
- Changed meaning/type of an existing field, renamed field, restructured data: bump `SCHEMA` in `simulation.ts` and migrate in `defineGame({ migrate })`:

  ```ts
  migrate(world) {
    if (world.schema < 2) {
      for (const p of Object.values(world.players)) p.gold = (p as any).coins ?? 0;   // coins → gold
      world.schema = 2;
    }
    return world;
  },
  ```

  Throwing in `migrate` keeps the old save untouched and pauses the game with the error — use it only when the save really cannot be used.
- Server-only helper state that clients do not need: list the key in `network.hidden`.
- Big dictionaries that change often: list them in `network.entities`.

## 3. Use the kit instead of re-inventing

`@gaime/core/kit` (docs/KIT.md): `moveTopDown`, `clampToCircle`/`clampToRect`/`keepOutOfCircle`, `raycast`/`rayEnd`, `circlesOverlap`, `separate`, `SpatialHash` (many entities), `launch` + `stepProjectiles` (+ `ballisticAngle`), `cooldown.use`, `every`, `schedule`/`due`, `status.apply/value` (buffs, slows, stuns), `createMatch`/`setReady`/`stepMatch`/`endMatch` (rounds), `createTurns`/`nextTurn`/`freezeTurn` (turn-based), inventory (`addItem`, `takeItem`), `balancedTeam`, `weighted`/`shuffle`/`pointInRing`, `addEffect`/`pruneEffects`.

## 4. Validate client input

Everything from the client is untrusted: check types (`Number.isFinite`), clamp ranges, check ownership/turn/cooldown/cost on the server. Return a string from `command()` to show the player why an action was refused.

## 5. Keep the client in sync

- If you changed shared movement, prediction on the client uses the same function automatically.
- Show new state in the HUD (`src/client/hud.ts` / `main.ts`) and scene; read the catalog for module data.
- New sound or event → register it in the client's `SoundBank` / `net.on('event')`.

## 6. Verify

```sh
npm run check && npx vitest run games/<game>
```

Write or extend a test in `games/<game>/tests/` with `testContext(world, { random: seeded(1) })`: set up a world, run `step` for N seconds, assert the outcome. For saves: build an "old" world object without the new field, run it through `hydrate` / your `migrate`, assert. With a dev server running, poke the live game: `cd games/<game> && npx gaime world <field>`, `npx gaime admin …`.

## Pitfalls

- `setTimeout`, module-level `let`, closures holding state → lost on hot reload, not saved.
- `Math.random()` / `Date.now()` in the simulation → untestable, inconsistent; use `ctx.random`, `world.time`.
- Changing `name` in `defineGame` resets everyone's identity and the save. Don't.
- A thrown exception in `step` pauses the game for everyone — test before pushing.

## Reference

`docs/SERVER.md` (tick, commands, context, persistence), `docs/KIT.md`, `docs/COOKBOOK.md` (rounds, teams, turns, shops, hidden information, migrations).
