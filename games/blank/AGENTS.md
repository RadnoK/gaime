# Blank (games/blank) — instructions for AI agents

The smallest complete gaime game: players walk on a square field and collect pickups for points. It exists to be copied (`npm run new-game -- my-game`, the default template) and turned into something else, so every file is short and shows one framework mechanism.

Read the general rules in [../../AGENTS.md](../../AGENTS.md) first. How to extend this game: [docs/ADDING_FEATURES.md](docs/ADDING_FEATURES.md). How to turn it into a new game: [../../docs/NEW_GAME.md](../../docs/NEW_GAME.md) and the `gaime-new-game` skill.

## Files

| File | What it shows |
| --- | --- |
| `src/shared/types.ts` | `World`, `Player`, `Input`, `Command`, the module kind `pickups` (`PickupDef`) |
| `src/shared/rules.ts` | constants and `movePlayer` shared by the server and client prediction (`moveTopDown`, `clampToRect` from the kit) |
| `src/server/simulation.ts` | `createWorld`, `createPlayer`, `step` (movement, pickup collection, spawning with `every`), `command` |
| `src/server/game.ts` | `defineGame`: network config, input validation, the `/bot` brain |
| `src/server/registry.ts` | module discovery + validation |
| `src/client/main.ts` | `GameClient` kept across HMR, `Controls` + `TouchControls`, `GameUi`, a HUD widget |
| `src/client/scene.ts` | `createStage`, `CameraRig`, `EntityLayer`, `ModelLibrary`, interpolation and prediction |
| `src/features/coins/server.ts` | a module: two pickups |
| `tests/simulation.test.ts` | logic tests with `testContext` |

## Adding content

A new pickup = `src/features/<id>/server.ts`:

```ts
import type { Feature } from '../../shared/types';
export default {
  author: 'Ola',
  pickups: [{ id: 'ola-star', name: 'Star', description: 'Ten points.', value: 10, weight: 0.5, visual: { shape: 'octahedron', color: '#ffe066', lift: 0.4 } }],
} satisfies Feature;
```

For anything bigger (enemies, abilities, rounds) add a new module kind — see the `gaime-module-kind` skill — or start from `games/starter` / `games/duel`, which already have them.
