# Duel (games/duel) — instructions for AI agents

Turn-based 1v1 artillery in a side view (the Worms / super-popes genre): two seats plus spectators, ready → countdown → round → result → rematch, a turn timer, wind rerolled every turn, destructible height-field terrain, weapons as modules, and a computer opponent (`/bot`).

Read the general rules in [../../AGENTS.md](../../AGENTS.md) first. How to add weapons: [docs/ADDING_FEATURES.md](docs/ADDING_FEATURES.md).

## Coordinates

The simulation plane is **x (right) / z (up)**. `terrain` is a height field: one height every `RULES.step` units from `-RULES.width / 2`. The renderer maps z to the screen's vertical axis (`at()` in `src/client/scene.ts`). Aim angles are degrees from +X towards up (0 = right, 90 = up, 180 = left); the kit's `launch()` uses radians from +Z, so `sim.launch` converts.

## Flow

- `match` (kit `MatchState`): `stepMatch` with `minPlayers: 2`; `ready` commands toggle readiness; `ended` → a `ready` goes back to the lobby (rematch).
- `turns` (kit `TurnState`): only the current player walks, aims and fires once; firing freezes the clock; when every projectile is gone the shooter gets `RULES.retreatSeconds` to walk, then the turn passes and the wind changes. A timeout also passes the turn.
- Projectiles: kit `stepProjectiles` with gravity × `weapon.gravity` and wind × `weapon.wind`; hits on players or terrain call `weapon.onImpact` or the default `sim.explode`.
- `sim.explode` carves the terrain, damages players with falloff, adds an explosion effect and a sound event; players fall when the ground under them disappears.
- Seats: `createPlayer` gives seat 0, 1 or -1 (spectator). A human joining while a bot holds a seat takes it over (`onPlayerOnline`). `keepPlayers: false` — leaving frees the seat.

## Where things are

- `src/shared/types.ts` — `World`, `Player`, `Input`, `Command`, `Sim`, `WeaponDef`.
- `src/shared/rules.ts` — constants, terrain generation, `heightAt`, `carve`, `muzzle`.
- `src/server/simulation.ts` — the round, turns, projectiles, commands, seats, the bot brain (`botInput`).
- `src/features/artillery`, `src/features/cluster` — weapons; `cluster` shows `onImpact` spawning bomblets.
- `src/client/scene.ts` — terrain mesh, fighters, shells, effects, trajectory preview, camera framing.
- `src/client/hud.ts` — turn/timer, wind, score, power meter, weapon bar, banners (on top of `GameUi`).
- `src/client/main.ts` — controls: A/D walk, W/S aim, hold Space to charge, 1–9 weapons.
- `tests/simulation.test.ts` — seats, match flow, firing rules, a full bot-vs-bot round.

## Checking

```sh
npm run check && npm test          # from the repo root
npm run dev -- duel                # http://localhost:5173 — /bot in chat for an opponent
```
