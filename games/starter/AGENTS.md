# Crystal (games/starter) — instructions for AI agents

Co-op defense of a crystal in the middle of a round 3D arena (top-down, angled camera). Players shoot (LMB), have two abilities (Q/E), and waves of enemies walk to the crystal. This game is also the **template** for new games (`npm run new-game`), so keep it readable.

Read the general rules in [../../AGENTS.md](../../AGENTS.md) and the simulation model in [../../docs/SIMULATION.md](../../docs/SIMULATION.md) first. A full guide with ready code: [docs/ADDING_FEATURES.md](docs/ADDING_FEATURES.md).

## Adding content = a new module

`src/features/<id>/server.ts` with a default export `satisfies Feature` (types in `src/shared/types.ts`). A module has **definitions** (the kinds below) and/or **behaviour** (`on`, `modify`, `systems`, `commands`):

| Kind | Type | What it does |
| --- | --- | --- |
| `enemies` | `EnemyDef` | an enemy: `hp`, `speed`, `radius`, `damage` (per second of contact), `reward`, `visual`; optionally `tick(sim, enemy)` replacing the default AI, and `onDeath` |
| `abilities` | `AbilityDef` | a Q/E ability: `cooldown`, `color`, `icon`, `cast(sim, player, target)` |
| `waves` | `WaveDef` | an attack: `minWave`, `weight`, `start(sim, wave)` schedules enemies with `sim.spawn` |

| Behaviour | Example in this game |
| --- | --- |
| `on: { 'wave.cleared': (event, sim) => … }` — react to a game event | `field-kit` heals everyone when a wave is cleared |
| `modify: { 'enemy.speed': (speed, data, sim) => … }` — adjust a number | `frost` slows chilled enemies |
| `systems: [{ id, every?, phase?, run(sim, dt) }]` — per-tick or periodic work | `crystal-golem` slams every 6 s |
| `commands: { '<module-id>-…': (playerId, command, sim) => … }` — a new player action | see ADDING_FEATURES.md |

### Events (`ctx.trigger` / `sim.trigger`, handled with `on`)

| Event | Payload | When |
| --- | --- | --- |
| `enemy.spawn` | `{ id, kind, x, z }` | timer from `sim.spawn` (key `spawn:<n>`): the enemy enters now |
| `enemy.spawned` | `{ enemy, kind, x, z }` | an enemy entered the arena |
| `enemy.died` | `{ enemy, kind, by?, x, z, reward }` | killed; `by` = the player, `reward` already modified. The game adds the score and the kill here |
| `player.downed` | `{ playerId, x, z }` | a player reached 0 HP (sent to clients: sound + shake) |
| `player.respawn` / `player.respawned` | `{ playerId }` | timer `player:<id>:respawn` / the player is back |
| `ability.cast` | `{ playerId, ability, x, z }` | a player used an ability |
| `wave.start` | `{ wave }` | timer `wave:next` at the end of the break |
| `wave.started` | `{ wave, attack, name }` | a wave began (sent to clients) |
| `wave.cleared` | `{ wave, bonus }` | no enemy alive and no `spawn:` timer left (sent to clients) |
| `round.lost` | `{ wave, score }` | the crystal fell (sent to clients) |

Module-private events: prefix them with your module id and add them to `Events` in `src/shared/types.ts` (the type is shared).

### Modifiers (`sim.modify(name, value, data)`, adjusted with `modify`)

| Name | Value | Data |
| --- | --- | --- |
| `enemy.speed` | units/s (the game applies `sim.slow` here) | `{ enemy, kind }` |
| `enemy.hp` | max HP at spawn (wave scaling included) | `{ kind, wave }` |
| `enemy.damage` | damage an enemy takes | `{ enemy, kind, by?, source }` (`'shot'`, an ability id…) |
| `enemy.reward` | score for a kill | `{ enemy, kind, by? }` |
| `player.damage` | damage a player takes | `{ playerId, source }` (enemy kind…) |
| `crystal.damage` | damage the crystal takes | `{ source }` |
| `ability.cooldown` | seconds | `{ playerId, ability }` |

### Rules for module code

- Change the world through `Sim` (`hurtEnemy`, `hurtPlayer`, `hurtCrystal`, `heal`, `spawn`, `slow`, `enemySpeed`, `moveTowards`, `effect`, `emit`, `log`) — damage then goes through the modifiers, deaths trigger the events, and scoring stays in one place.
- Later, once: a timer — `sim.after(3, '<event>', data, 'enemy:<id>:<module-id>-…')`. Timers of an enemy keyed `enemy:<id>:…` are cancelled when it dies. Durations read on demand (slows, buffs): kit `status` in `enemy.data` / `player.data`.
- Periodic: a module system with `every: seconds`, never `world.time % n`.
- An enemy with no wave that summons it never appears — add `waves` as well (or use an existing one).
- Keep module state in `enemy.data['<module-id>-…']` / `player.data['<module-id>-…']` (number/string/boolean only).
- `sim.defaultAi(enemy)` is the built-in behaviour; call it from your own `tick` to extend it instead of rewriting it. Move enemies at `sim.enemySpeed(enemy)` so slows and modifiers apply.
- A module that throws is switched off (⚠ in the feed); its enemies fall back to the default AI, its waves and abilities are skipped. Tests use `strict` mode, so the error fails the test instead.
- Looks: `visual: { shape, color, scale, emissive, lift }`. Built-in shapes: `box`, `sphere`, `capsule`, `cone`, `cylinder`, `torus`, `octahedron`, `ring`. A custom shape → `src/features/<id>/client.ts` with `models: { '<shape>': visual => THREE.Object3D }` (example: `crystal-golem/client.ts`). A model is ~1 unit tall, stands on y = 0 and faces +Z.
- Effects (`sim.effect`): `tracer` (x2/z2), `pulse` (radius), `hit`, `spawn`, `text` (text). Sounds: the client plays them for the forwarded events above; a module's own cue: `sim.emit('sound', { kind })` with a kind from the `SoundBank` in `src/client/main.ts`.

## Where things are

- `src/shared/types.ts` — `World`, `Player`, `Enemy`, `Input`, `Command`, **`Events`**, **`Modifiers`**, `Sim`, module definitions.
- `src/shared/rules.ts` — balance constants, player movement (shared with client prediction).
- `src/server/simulation.ts` — `makeSim` (the `Sim` facade), `step` (movement, shooting), systems (enemy AI, separation, round end, effects), event handlers, waves, commands, bots, `migrate`.
- `src/server/game.ts` — `defineGame`: tick order, `systems`, `on`, `modify`, networking (`network.events`), RPC (`requests`), chat commands, admin commands.
- `src/server/tactics.ts` + `src/workers/tactics.ts` — example worker pool (`/report` in chat).
- `src/client/scene.ts` — Three.js (interpolation, own-character prediction, effects), `hud.ts` — DOM, `main.ts` — wiring, sounds for events, HMR.
- `tests/simulation.test.ts` — `testGame` tests (waves, deaths, respawn, modules, isolation, migration, bots, jobs).

Pending enemies are timers (`spawn:<n>`), not world state: count them with `sim.timers('spawn:')`. `world.nextWaveAt` and `player.respawnAt` exist for the HUD; the timers do the work. `SCHEMA` is 2 — `migrate` turns schema-1 saves (`world.spawns`) into timers.

## Checking

```sh
npm run check && npm test          # from the repo root
npm run dev                        # http://localhost:5173 (second player: ?player=2, lag: ?lag=150)
npx gaime admin wave 3             # inside the game directory, on a running server
npx gaime admin spawn <enemy-id> 5
curl -s localhost:5173/gaime/stats # `parts`: cost of each system / handler / command
```

When you finish, describe where the effect shows up in the game (arsenal on Tab, wave from number N, chat /command).
