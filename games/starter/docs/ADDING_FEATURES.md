# Adding features to "Crystal"

## Prompt to paste to your AI

```text
Read AGENTS.md, games/starter/AGENTS.md, games/starter/docs/ADDING_FEATURES.md
and games/starter/src/shared/types.ts.
Author: [name]. Directory: games/starter/src/features/[unique-id]/.
Idea: [e.g. an ice turret, an enemy that multiplies, a teleport ability].
Visible effect: [what the player sees and how they use it].
Add a working module that fits the current API, with a name, description and author.
If you add an enemy, add a wave that summons it.
Keep the save compatible and other people's changes intact. Run npm run check and npm test.
At the end tell me how to see the new feature in the game.
```

## The shortest path

1. Create `src/features/<id>/server.ts` (id = lowercase letters and dashes, e.g. `ola-swamp`).
2. `export default { author, description, enemies?, abilities?, waves? } satisfies Feature;`
3. Save — the dev server discovers the module; a new ability shows up in the arsenal (Tab), a new wave joins the rotation.
4. Prefix definition ids with the module name and never change them afterwards (they are stored in saves).

## Full example: a swamp

`src/features/ola-swamp/server.ts`:

```ts
import { dist } from '@gaime/core';
import type { Feature } from '../../shared/types';

export default {
  author: 'Ola',
  description: 'Bog creatures that slow players, and a "Drought" ability.',
  enemies: [{
    id: 'ola-bog',
    name: 'Bog creature',
    description: 'Slow, but every 2 s it slows players within 3 m.',
    hp: 140, speed: 1.6, radius: 0.9, damage: 18, reward: 25,
    visual: { shape: 'ola-bog', color: '#5d7f3a' },
    tick(sim, bog) {
      const next = Number(bog.data['ola-bog-next'] ?? 0);
      if (sim.world.time >= next) {
        sim.effect('pulse', bog, { radius: 3, color: '#5d7f3a' });
        for (const player of sim.players()) {
          if (dist(player, bog) <= 3) player.data['ola-bog-slow-until'] = sim.world.time + 1.5;
        }
        bog.data['ola-bog-next'] = sim.world.time + 2;
      }
      sim.defaultAi(bog);              // the built-in AI does the rest
    },
    onDeath(sim, bog) {
      sim.effect('text', bog, { text: 'splash!', color: '#9fdc6a' });
    },
  }],
  abilities: [{
    id: 'ola-drought',
    name: 'Drought',
    description: 'Deals 60 damage to bog creatures within 10 m.',
    cooldown: 15, color: '#e0b25a', icon: '☀',
    cast(sim, player) {
      sim.effect('pulse', player, { radius: 10, color: '#e0b25a' });
      for (const enemy of sim.enemies()) {
        if (enemy.kind === 'ola-bog' && dist(enemy, player) <= 10) sim.hurtEnemy(enemy, 60, player.id);
      }
    },
  }],
  waves: [{
    id: 'ola-swamp',
    name: 'Swamp',
    description: 'Bog creatures escorted by runners. From wave 2.',
    minWave: 2,
    start(sim, wave) {
      sim.spawn('ola-bog', { count: 2 + wave, interval: 1.5 });
      sim.spawn('runner', { count: wave * 2, delay: 4, interval: 0.5 });
    },
  }],
} satisfies Feature;
```

`player.data['ola-bog-slow-until']` does nothing by itself — player movement is computed by `movePlayer` in `src/shared/rules.ts`. When a mechanic needs a core change (here: slowing players), make it explicit and general (e.g. a `player.data['slow-until']` field respected by `movePlayer`), document it in the game's AGENTS.md and agree on it with the team.

A custom model — `src/features/ola-swamp/client.ts`:

```ts
import * as THREE from 'three';
import type { ClientFeature } from '../../client/features';

export default {
  models: {
    'ola-bog'(visual) {
      const group = new THREE.Group();
      const body = new THREE.Mesh(new THREE.SphereGeometry(0.5, 16, 12), new THREE.MeshStandardMaterial({ color: visual.color, roughness: 1 }));
      body.scale.set(1.3, 0.7, 1.3);
      body.position.y = 0.35;
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.08), new THREE.MeshStandardMaterial({ color: '#fff', emissive: '#ff0' }));
      eye.position.set(0, 0.6, 0.45);
      group.add(body, eye);
      return group;
    },
  },
} satisfies ClientFeature;
```

## API at a glance (`Sim`)

| Method | Description |
| --- | --- |
| `world`, `dt`, `random()` | world state, step in seconds, randomness |
| `enemies()`, `players()` | living enemies / players that are online and alive |
| `nearestEnemy(from, range?)`, `nearestPlayer(from, range?)` | nearest target |
| `hurtEnemy(enemy, dmg, byPlayerId?)` | damage; a kill awards score and calls `onDeath` |
| `hurtPlayer(player, dmg)`, `heal(player, hp)`, `hurtCrystal(dmg)` | player and crystal health |
| `spawn(enemyId, { count, delay, interval, x, z })` | spawn queue (the arena edge by default) |
| `slow(enemy, factor, seconds)` | slow an enemy down |
| `moveTowards(entity, target, speed)` | movement that respects slows; returns the remaining distance |
| `defaultAi(enemy)` | built-in enemy behaviour |
| `effect(type, at, options)` | visual effect: `tracer`, `pulse`, `hit`, `spawn`, `text` |
| `emit(name, data, playerId?)` | one-off event for clients (e.g. `'sound'`) |
| `log(text)` | a feed message for everyone |

Heavy computation (e.g. analysing the whole map) does not belong in `tick` — see `src/workers/tactics.ts` and the `/report` chat command in `src/server/game.ts`.

## Testing a module

```ts
import { testContext } from '@gaime/core/server';
// see tests/simulation.test.ts: createWorld(), createPlayer(), step(...), command(...)
```

In a running game: `npx gaime admin spawn ola-bog 3` and `npx gaime admin wave 2` (inside `games/starter`).
