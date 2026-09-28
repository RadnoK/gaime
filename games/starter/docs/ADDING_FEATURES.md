# Adding features to "Crystal"

## Prompt to paste to your AI

```text
Read AGENTS.md, docs/SIMULATION.md, games/starter/AGENTS.md, games/starter/docs/ADDING_FEATURES.md
and games/starter/src/shared/types.ts.
Author: [name]. Directory: games/starter/src/features/[unique-id]/.
Idea: [e.g. an ice turret, an enemy that multiplies, a teleport ability].
Visible effect: [what the player sees and how they use it].
Add a working module that fits the current API, with a name, description and author.
React to game events with `on`, adjust numbers with `modify`, do periodic work in `systems`
with `every`, and schedule "later" with timers — do not edit the game's core for that.
If you add an enemy, add a wave that summons it.
Keep the save compatible and other people's changes intact. Run npm run check and npm test.
At the end tell me how to see the new feature in the game.
```

## The shortest path

1. Create `src/features/<id>/server.ts` (id = lowercase letters and dashes, e.g. `ola-swamp`).
2. `export default { author, description, enemies?, abilities?, waves?, on?, modify?, systems?, commands? } satisfies Feature;`
3. Save — the dev server discovers the module; a new ability shows up in the arsenal (Tab), a new wave joins the rotation, handlers and systems start running.
4. Prefix definition ids, system ids, command types, timer keys and `data` keys with the module name, and never change ids afterwards (they are stored in saves).

## Where things go

| You need… | Use |
| --- | --- |
| a new enemy / ability / attack | `enemies` / `abilities` / `waves` |
| "when X happens, do Y" (a kill, a cleared wave, a downed player) | `on: { 'enemy.died': (event, sim) => … }` |
| change a number the game computes (damage, speed, reward, cooldown) | `modify: { 'player.damage': (amount, data, sim) => … }` |
| something periodic (an aura, regeneration, a spawner) | `systems: [{ id: '<module-id>-…', every: 2, run: sim => … }]` |
| something once, later (a fuse, a delayed wave) | `sim.after(seconds, event, data, key)` — a timer, saved with the world |
| a timed state read on demand (chill, shield, rage) | kit `status` in `enemy.data` / `player.data` |
| a new player action | `commands: { '<module-id>-…': (playerId, command, sim) => … }` |

The event and modifier names are listed in [../AGENTS.md](../AGENTS.md) and typed in `src/shared/types.ts` (`Events`, `Modifiers`).

## Full example: a swamp

`src/features/ola-swamp/server.ts`:

```ts
import { dist } from '@gaime/core';
import { status } from '@gaime/core/kit';
import type { Feature } from '../../shared/types';

export default {
  author: 'Ola',
  description: 'Bog creatures that make players take more damage, and a "Drought" ability.',
  enemies: [{
    id: 'ola-bog',
    name: 'Bog creature',
    description: 'Slow; players within 3 m are soaked and take 50% more damage for 1.5 s.',
    hp: 140, speed: 1.6, radius: 0.9, damage: 18, reward: 25,
    visual: { shape: 'ola-bog', color: '#5d7f3a' },
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
        if (enemy.kind === 'ola-bog' && dist(enemy, player) <= 10) sim.hurtEnemy(enemy, 60, player.id, 'ola-drought');
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

  // Periodic work: twice a second, not every tick (the engine staggers it against other systems).
  systems: [{
    id: 'ola-soak',
    every: 0.5,
    run(sim) {
      for (const bog of sim.enemies()) {
        if (bog.kind !== 'ola-bog') continue;
        for (const player of sim.players()) if (dist(player, bog) <= 3) status.apply(player.data, 'ola-soaked', sim.world.time, 1.5);
      }
    },
  }],

  // A number the game computes: soaked players take 50% more damage — from any source.
  modify: {
    'player.damage': (amount, { playerId }, sim) => {
      const player = sim.world.players[playerId];
      return player && status.active(player.data, 'ola-soaked', sim.world.time) ? amount * 1.5 : amount;
    },
  },

  // A reaction to a game fact: killing a bog creature with Drought is worth 10 bonus points.
  on: {
    'enemy.died': ({ kind, by }, sim) => {
      if (kind === 'ola-bog' && by) sim.world.score += 10;
    },
  },
} satisfies Feature;
```

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

## More patterns

A custom enemy AI extends the default one — and moves at `sim.enemySpeed(enemy)` so slows and speed modifiers apply:

```ts
tick(sim, enemy) {
  const player = sim.nearestPlayer(enemy, 12);
  if (player && enemy.hp < enemy.maxHp / 2) sim.moveTowards(enemy, { x: enemy.x * 2 - player.x, z: enemy.z * 2 - player.z }, sim.enemySpeed(enemy) * 1.5);
  else sim.defaultAi(enemy);
},
```

"Later" is a timer; key it by the enemy so its death cancels it (`enemy:<id>:…` keys are cancelled automatically when the enemy dies). The event it fires needs an entry in `Events` in `src/shared/types.ts` (prefixed with your module id):

```ts
// types.ts:  'ola-bomb.explode': { enemy: string };
cast(sim, player, target) {
  const bomb = sim.nearestEnemy(target, 3);
  if (bomb) sim.after(2, 'ola-bomb.explode', { enemy: bomb.id }, `enemy:${bomb.id}:ola-bomb`);
},
// in the module:
on: {
  'ola-bomb.explode': ({ enemy }, sim) => {
    const target = sim.world.enemies[enemy];           // it may be gone — check
    if (target) sim.hurtEnemy(target, 200, undefined, 'ola-bomb');
  },
},
```

A new player action (the client sends `net.command({ type: 'ola-taunt' })`):

```ts
commands: {
  'ola-taunt': (playerId, _command, sim) => {
    const player = sim.world.players[playerId];
    if (!player || player.respawnAt) return 'You are down.';   // a returned string goes back to the player
    for (const enemy of sim.enemies()) status.apply(enemy.data, 'ola-taunted', sim.world.time, 3);
  },
},
```

## API at a glance (`Sim`)

| Member | Description |
| --- | --- |
| `world`, `dt`, `random()` | world state, seconds since the last run (tick or `every` interval; 0 in commands), randomness |
| `trigger(event, data)` | put an event on the bus; `on` handlers run right after the current code |
| `after(seconds, event, data, key?)`, `cancel(key, { prefix? })`, `timeLeft(key)`, `timers(prefix?)` | timers (saved with the world; the same key replaces a timer) |
| `modify(name, value, data)` | pass a number through every `modify[name]` |
| `isolate(module, run)`, `disabled(module)` | run module-owned code (an error switches the module off), check whether a module is off |
| `enemies()`, `players()` | living enemies / players that are online and alive |
| `nearestEnemy(from, range?)`, `nearestPlayer(from, range?)` | nearest target |
| `hurtEnemy(enemy, dmg, byPlayerId?, source?)` | damage via `enemy.damage`; a kill calls `onDeath` and triggers `enemy.died` (the game scores it) |
| `hurtPlayer(player, dmg, source?)`, `heal(player, hp)`, `hurtCrystal(dmg, source?)` | player and crystal health (`player.damage`, `crystal.damage`) |
| `spawn(enemyId, { count, delay, interval, x, z })` | schedule enemies as `spawn:` timers (the arena edge by default) |
| `slow(enemy, factor, seconds)`, `enemySpeed(enemy)` | slow an enemy (strongest wins); its speed through `enemy.speed` |
| `moveTowards(entity, target, speed)` | move at `speed` units/s; returns the remaining distance |
| `defaultAi(enemy)` | built-in enemy behaviour |
| `effect(type, at, options)` | visual effect: `tracer`, `pulse`, `hit`, `spawn`, `text` |
| `emit(name, data, playerId?)` | one-off event for clients (e.g. `'sound'`) |
| `log(text)` | a feed message for everyone |

Heavy computation (e.g. analysing the whole map) does not belong in a system or `tick` — see `src/workers/tactics.ts` and the `/report` chat command in `src/server/game.ts`.

## Testing a module

`testGame` runs the real engine (timers, events, systems, modules) without a network — see `tests/simulation.test.ts`:

```ts
import { seeded } from '@gaime/core';
import { testGame } from '@gaime/core/server';
import { game } from '../src/server/game';

test('soaked players take more damage', () => {
  const t = testGame(game, { random: seeded(1) });
  const ola = t.join('Ola');
  t.command(ola, { type: 'start' });
  // Sim helpers from a test: `outside` dispatches the events they trigger.
  t.engine.outside(() => t.sim().spawn('ola-bog', { x: t.player(ola).x + 2, z: t.player(ola).z }));
  t.run(2);
  expect(t.player(ola).data['ola-soaked:until']).toBeGreaterThan(t.world.time);
  expect(t.triggeredOf('enemy.spawned')).toContainEqual(expect.objectContaining({ kind: 'ola-bog' }));
});
```

Module errors throw in tests (strict mode); `testGame(game, { strict: false })` checks that the game survives a module being switched off (`t.disabled`).

In a running game: `npx gaime admin spawn ola-bog 3` and `npx gaime admin wave 2` (inside `games/starter`).
