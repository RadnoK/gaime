# Crystal (games/starter) — instructions for AI agents

Co-op defense of a crystal in the middle of a round 3D arena (top-down, angled camera). Players shoot (LMB), have two abilities (Q/E), and waves of enemies walk to the crystal. This game is also the **template** for new games (`npm run new-game`), so keep it readable.

Read the general rules in [../../AGENTS.md](../../AGENTS.md) first. A full guide with ready code: [docs/ADDING_FEATURES.md](docs/ADDING_FEATURES.md).

## Adding content = a new module

`src/features/<id>/server.ts` with a default export `satisfies Feature` (types in `src/shared/types.ts`):

| Kind | Type | What it does |
| --- | --- | --- |
| `enemies` | `EnemyDef` | an enemy: `hp`, `speed`, `radius`, `damage` (per second of contact), `reward`, `visual`; optionally `tick(sim, enemy)` replacing the default AI, and `onDeath` |
| `abilities` | `AbilityDef` | a Q/E ability: `cooldown`, `color`, `icon`, `cast(sim, player, target)` |
| `waves` | `WaveDef` | an attack: `minWave`, `weight`, `start(sim, wave)` queues enemies with `sim.spawn` |

- An enemy with no wave that summons it never appears — add `waves` as well (or use an existing one).
- Keep enemy state in `enemy.data['<module-id>-…']` (number/string/boolean only).
- Change the world through `Sim` (`hurtEnemy`, `hurtPlayer`, `hurtCrystal`, `heal`, `spawn`, `slow`, `moveTowards`, `effect`, `emit`, `log`) — that way modules work together (score, death, effects).
- `sim.defaultAi(enemy)` is the built-in behaviour; call it from your own `tick` to extend it instead of rewriting it.
- Looks: `visual: { shape, color, scale, emissive, lift }`. Built-in shapes: `box`, `sphere`, `capsule`, `cone`, `cylinder`, `torus`, `octahedron`, `ring`. A custom shape → `src/features/<id>/client.ts` with `models: { '<shape>': visual => THREE.Object3D }` (example: `crystal-golem/client.ts`). A model is ~1 unit tall, stands on y = 0 and faces +Z.
- Effects (`sim.effect`): `tracer` (x2/z2), `pulse` (radius), `hit`, `spawn`, `text` (text). Sounds: `sim.emit('sound', { kind })` — kinds in `src/client/audio.ts`.

## Where things are

- `src/shared/types.ts` — `World`, `Player`, `Enemy`, `Effect`, `Input`, `Command`, `Sim`, module definitions.
- `src/shared/rules.ts` — balance constants, player movement (shared with client prediction).
- `src/server/simulation.ts` — game loop, `Sim`, shooting, waves, commands.
- `src/server/game.ts` — `defineGame`: networking, RPC (`requests`), chat commands, admin commands.
- `src/server/tactics.ts` + `src/workers/tactics.ts` — example worker pool (`/report` in chat).
- `src/client/scene.ts` — Three.js (interpolation, own-character prediction, effects), `hud.ts` — DOM, `main.ts` — wiring + HMR.
- `tests/simulation.test.ts` — logic tests on `testContext`.

## Checking

```sh
npm run check && npm test          # from the repo root
npm run dev                        # http://localhost:5173 (second player: ?player=2, lag: ?lag=150)
npx gaime admin wave 3             # inside the game directory, on a running server
npx gaime admin spawn <enemy-id> 5
```

When you finish, describe where the effect shows up in the game (arsenal on Tab, wave from number N, chat /command).
