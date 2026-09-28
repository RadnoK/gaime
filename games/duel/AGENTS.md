# Duel (games/duel) — instructions for AI agents

Turn-based 1v1 artillery in a side view (the Worms / super-popes genre): two seats plus spectators, ready → countdown → round → result → rematch, a turn timer, wind rerolled every turn, destructible height-field terrain, weapons as modules, and a computer opponent (`/bot`).

Read the general rules in [../../AGENTS.md](../../AGENTS.md) and the simulation model in [../../docs/SIMULATION.md](../../docs/SIMULATION.md) first. How to add weapons and behaviour: [docs/ADDING_FEATURES.md](docs/ADDING_FEATURES.md).

## Coordinates

The simulation plane is **x (right) / z (up)**. `terrain` is a height field: one height every `RULES.step` units from `-RULES.width / 2`. The renderer maps z to the screen's vertical axis (`at()` in `src/client/scene.ts`). Aim angles are degrees from +X towards up (0 = right, 90 = up, 180 = left); the kit's `launch()` uses radians from +Z, so `sim.launch` converts.

## One tick

```text
timers (turn:end → turn.expired) → match (input) → step (walk, aim) → fall → shells → referee → turns → module systems → effects (late)
```

Events triggered anywhere are handled right after the piece of code that raised them (the game's `on` first, then modules' in file order).

## Flow

- **Match** (kit `MatchState`, system `match`): `stepMatch` with `minPlayers: 2`; `ready` commands toggle readiness; `ended` → a `ready` goes back to the lobby (rematch). Triggers `match.countdown`, `match.started`, `match.ended`.
- **Turns** (kit `TurnState` for order and the displayed clock, `world.turnPhase` for the stage): `aim` (the active player walks, aims, fires once) → `flight` (firing freezes the clock and cancels the turn timer) → `retreat` (system `turns` sees every shell landed, bomblets included: `turn.resolved`, `RULES.retreatSeconds` to walk) → next turn. The end of a turn — timeout or end of the retreat — is **one timer keyed `turn:end`** firing `turn.expired { turn }`; the handler ignores stale turns. Every new turn rerolls the wind through `wind.strength` and triggers `turn.started`.
- **Shells** (system `shells`): kit `stepProjectiles` with gravity × `weapon.gravity` and wind × `weapon.wind`. An impact triggers `shell.impact`; the game's handler runs `weapon.onImpact` (isolated, owned by the weapon's module) or the default `sim.explode` with `shell.radius`.
- **`sim.explode`** carves the terrain, damages players with falloff through `shell.damage`, adds effects and triggers `player.hit`, `player.died`, `shell.exploded`; players fall when the ground under them disappears (system `fall`, which also kills players falling off the map).
- **Referee** (system `referee`): at most one fighter alive (a hit, a fall, a player leaving) → the round ends, `turn:` timers are cancelled.
- **Seats**: `createPlayer` gives seat 0, 1 or -1 (spectator). A human joining while a bot holds a seat takes it over (`onPlayerOnline`; a running round is called off). `keepPlayers: false` — leaving frees the seat.
- **Bot** (`botInput`): readies up, aims a ballistic shot once per turn (`duel-bot-*` keys in `data`), fires through `ctx.command` like a player.

## Events (`src/shared/types.ts`)

| Event | Payload | Raised by | To clients |
| --- | --- | --- | --- |
| `match.countdown` | `seconds` | system `match` | ✓ tick sound |
| `match.started` | `round, players` | system `match` | ✓ start sound |
| `match.ended` | `round, winner, reason` | `referee`, seat hand-over | ✓ win sound |
| `turn.started` | `player, turn, wind` | round start, turn change | ✓ "your turn" tick |
| `turn.expired` | `turn` | timer `turn:end` | |
| `turn.resolved` | `player, turn` | system `turns` (all shells landed) | |
| `shell.fired` | `player, weapon, power` | `fire` command | ✓ fire sound |
| `shell.impact` | `shell, weapon, owner, x, z, vx, vz, target, data` | system `shells` | |
| `shell.exploded` | `x, z, radius, by, weapon` | `sim.explode` | ✓ boom, shake, rumble |
| `player.hit` | `player, by, weapon, damage` | `sim.explode` | ✓ rumble when it is you |
| `player.died` | `player, by, cause` (`shell` / `fall`) | `sim.explode`, system `fall` | |

## Modifiers

| Name | Value | Data | Used by |
| --- | --- | --- | --- |
| `shell.damage` | damage to one player after falloff | `player, by, weapon, distance` | `sim.explode` |
| `shell.radius` | radius of a weapon's default explosion | `weapon, owner` | the `shell.impact` handler |
| `wind.strength` | the wind rolled for a turn (rounded to 0.5 afterwards) | `player, turn` | every new turn (`weather` module) |

## `Sim` (what handlers, systems and weapon hooks receive)

`world`, `dt`, `random`, `trigger`, `after(seconds, event, data, key?)`, `cancel(key, prefix?)`, `modify`, `log`, `emit`, `isolate`, `fighters()`, `heightAt(x)`, `explode(at, radius, damage, by, weapon?)`, `launch(weapon, from, angleDegrees, speed, owner)` (returns the projectile).

## Where things are

- `src/shared/types.ts` — `World`, `Player`, `TurnPhase`, `Input`, `Command`, `Events`, `Modifiers`, `Sim`, `WeaponDef`.
- `src/shared/rules.ts` — constants, terrain generation, `heightAt`, `carve`, `muzzle`.
- `src/server/simulation.ts` — the facade (`makeSim`), round and turn rules, systems, handlers, commands, seats, the bot brain, `migrate`.
- `src/server/game.ts` — `defineGame`: network (forwarded events), systems order, `on` handlers.
- `src/features/artillery` — plain weapons; `src/features/cluster` — bomblets through `on: { 'shell.impact' }`; `src/features/weather` — a behaviour-only module (`modify` + `on`).
- `src/client/main.ts` — controls (A/D walk, W/S aim, hold Space to charge, 1–9 weapons) and sounds/shake from server events.
- `src/client/scene.ts` — terrain mesh, fighters, shells, effects, trajectory preview, camera framing.
- `src/client/hud.ts` — turn/timer, wind, score, power meter, weapon bar, banners (on top of `GameUi`).
- `tests/simulation.test.ts` — `testGame`: seats, match flow, firing rules, timers, modules, isolation, a full bot-vs-bot round, save migration.

## Saves

`SCHEMA = 2`: schema 1 had `shotFired` + `retreatUntil`; `migrate` turns them into `turnPhase`, and `prepare` schedules a missing `turn:end` timer for a turn in progress (also after any load or hot reload).

## Checking

```sh
npm run check && npm test          # from the repo root
npm run dev -- duel                # http://localhost:5173 — /bot in chat for an opponent
```
