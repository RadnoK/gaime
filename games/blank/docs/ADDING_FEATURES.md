# Adding features to "Blank"

Blank has one module kind, `pickups`. A pickup module is a file `src/features/<id>/server.ts`:

```ts
import type { Feature } from '../../shared/types';

export default {
  author: 'Ola',
  description: 'A rare star that also teleports you to the centre.',
  pickups: [{
    id: 'ola-star',
    name: 'Star',
    description: 'Ten points, and back to the centre.',
    value: 10,
    weight: 0.5,                       // relative spawn chance (coins have 10)
    visual: { shape: 'octahedron', color: '#ffe066', emissive: '#aa8800', scale: 0.9, lift: 0.4 },
    onPickup(world, player) {          // optional extra effect
      player.x = 0; player.z = 0;
    },
  }],
} satisfies Feature;
```

Save the file — the dev server discovers it, and stars start spawning. Ids are global and stable (prefix them with your name). `visual.shape` is a built-in primitive (`box`, `sphere`, `capsule`, `cone`, `cylinder`, `torus`, `octahedron`, `ring`) or a custom model registered from a client module (see `games/starter/src/features/crystal-golem/client.ts` and `games/starter/src/client/features.ts` for the pattern).

## Growing the game

Blank is deliberately tiny. Typical next steps, each with a skill in `.claude/skills/`:

- a new mechanic (health, shooting, rounds) — `gaime-mechanic`,
- a new kind of module (enemies, weapons, power-ups with timers) — `gaime-module-kind`,
- HUD and visuals — `gaime-client`,
- heavy computation — `gaime-worker`.

The kit (`@gaime/core/kit`) already has collisions, raycasts, projectiles, cooldowns, match lifecycle, turns, inventories and teams — see [docs/KIT.md](../../../docs/KIT.md).
