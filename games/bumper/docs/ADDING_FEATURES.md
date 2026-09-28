# Adding features to "Bumper"

Everything new goes into its own module: a directory `src/features/<id>/` with a `server.ts`. A module can add **content** (powerups) and **behaviour** (`on`, `modify`, `systems`, `commands`) — or both. Save the file and the dev server picks it up while the game runs. The API is listed in [../AGENTS.md](../AGENTS.md) (events, modifiers, `Sim`, `PowerupDef`); the model behind it in [SIMULATION.md](../../../docs/SIMULATION.md), the physics in [PHYSICS.md](../../../docs/PHYSICS.md).

Prompt to paste into your AI:

```text
Read AGENTS.md, docs/SIMULATION.md, docs/PHYSICS.md and games/bumper/AGENTS.md. Author: <name>.
In games/bumper/src/features/<name>-<idea>/server.ts add <what>. Use the game's events
(player.knocked, player.bumped, dash.used, round.started, round.won, pickup.collected…), the
modifiers (dash.power, push.mass, move.accel) and the Sim helpers (push, knockOut, spawnPickup);
no edits outside that directory except a test. Add a testGame test in games/bumper/tests/,
run npm run check and npx vitest run games/bumper, and tell me how to see it.
```

## A new powerup

```ts
// src/features/ola-magnet/server.ts
import { status } from '@gaime/core/kit';
import type { Feature } from '../../shared/types';

const ACTIVE = 'powerup:ola-magnet';

export default {
  author: 'Ola',
  description: 'Magnet: pulls every other disc towards you for 4 s.',
  powerups: [{
    id: 'ola-magnet',
    name: 'Magnet',
    description: 'Pulls the others in for 4 s.',
    weight: 1,                        // relative spawn chance (turbo has 3)
    duration: 4,                      // the status `powerup:ola-magnet` lasts 4 s
    visual: { shape: 'torus', color: '#ff59d6', scale: 0.6, lift: 0.5 },
  }],
  systems: [{
    id: 'pull',
    run: sim => {
      for (const holder of sim.fighters()) {
        if (!status.active(holder.data, ACTIVE, sim.world.time)) continue;
        for (const other of sim.fighters()) {
          if (other.id === holder.id) continue;
          const dx = holder.x - other.x; const dz = holder.z - other.z; const d = Math.hypot(dx, dz) || 1;
          // An impulse (mass × Δv) per tick = a force × dt: heavy discs resist it.
          sim.push(other.id, { x: (dx / d) * 6 * sim.dt, z: (dz / d) * 6 * sim.dt });
        }
      }
    },
  }],
} satisfies Feature;
```

Collecting it is handled by the game: the status `powerup:<id>` is set for `duration` seconds (the client shows an aura in `visual.color`), then `onCollect` runs if the definition has one, then `pickup.collected` is triggered. The effect itself is your module's `modify`, `systems` or `on`, gated by `status.active(player.data, 'powerup:<id>', sim.world.time)`.

## Behaviour: `on`, `modify`, `systems`, `commands`

`src/features/streak/server.ts` is the built-in behaviour-only module. A bigger one using all four keys:

```ts
// src/features/ola-sumo/server.ts
import { cooldown, status } from '@gaime/core/kit';
import type { Feature } from '../../shared/types';

export default {
  author: 'Ola',
  description: 'Sumo rules: the round leader is heavier, bumps are announced, a brace action, a shockwave every 20 s.',

  on: {
    // Payloads carry ids — look things up and check they still exist.
    'player.bumped': ({ a, b, speed }, sim) => { if (speed > 12) sim.log(`💥 ${sim.world.players[a]?.name} and ${sim.world.players[b]?.name} collide!`); },
    'round.started': ({ players }, sim) => { for (const id of players) delete sim.world.players[id]?.data['ola-sumo-braced:until']; },
  },

  // Adjust a value the game computes. Return the new value (undefined keeps it).
  modify: {
    'push.mass': (mass, { player }, sim) => {
      const p = sim.world.players[player];
      if (!p) return mass;
      const braced = status.active(p.data, 'ola-sumo-braced', sim.world.time);
      const leader = Object.values(sim.world.players).every(other => other.wins <= p.wins) && p.wins > 0;
      return mass * (braced ? 4 : 1) * (leader ? 1.2 : 1);
    },
  },

  // Periodic work (every 20 s of game time, staggered, not while paused): push everyone outwards.
  systems: [
    { id: 'shockwave', every: 20, run: sim => {
      if (sim.world.match.phase !== 'playing') return;
      for (const p of sim.fighters()) {
        const d = Math.hypot(p.x, p.z) || 1;
        sim.push(p.id, { x: (p.x / d) * 5 * p.mass, z: (p.z / d) * 5 * p.mass });
      }
    } },
  ],

  // A new player action. The client sends net.command({ type: 'ola-sumo-brace' }).
  commands: {
    'ola-sumo-brace': (playerId, _command, sim) => {
      const p = sim.world.players[playerId];
      if (!p?.alive) return;
      if (!cooldown.use(p.data, 'ola-sumo-brace', sim.world.time, 8)) return 'Brace is recharging.';
      status.apply(p.data, 'ola-sumo-braced', sim.world.time, 1);
    },
  },
} satisfies Feature;
```

Rules that keep it safe for everyone playing:

- **No state outside the world**: counters, cooldowns and statuses live in `player.data` with your prefix; no module-level variables, `setTimeout` or `Date.now()`.
- **Physics through the JSON and the `Sim`**: move discs by changing `vx`/`vz` or with `sim.push` (mass-aware); teleport by setting `x`/`z`. Never import `@gaime/physics` or Rapier in a module — the physics step picks your changes up. Mass goes through `push.mass`.
- **Knockouts through `sim.knockOut`** (it triggers `player.knocked`, which the feed, the respawn timer and other modules rely on).
- **Later, once** → a timer: `sim.after(seconds, event, data, { key: 'ola-sumo:<id>' })` — one of the game's `Events`, or a private `<module-id>:<event>` handled by your own `on`.
- **Names are global**: command types `<module>-<action>`, system ids unique in your module, data keys prefixed.
- **Errors switch your module off**, not the game: a ⚠ line in the feed and `disabled` in `/health` until a fix is pushed. Tests are strict and throw instead.

A module can add a sound for one of the forwarded events in `src/client/main.ts` with `net.onEvent(…)`; the HUD and scene are placeholders — the game's look is yours to design.

## Test it

```ts
// tests/ola-sumo.test.ts
import { expect, test } from 'vitest';
import { seeded } from '@gaime/core';
import { testGame } from '@gaime/core/server';
import { game } from '../src/server/game';

test('bracing makes the disc four times as heavy for a second', () => {
  const t = testGame(game, { random: seeded(1) });
  const ada = t.join('Ada');
  expect(t.command(ada, { type: 'ola-sumo-brace' })).toBeUndefined();
  t.tick();
  expect(t.player(ada).mass).toBe(4);
  expect(t.command(ada, { type: 'ola-sumo-brace' })).toMatch(/recharging/);
  t.run(1.1);
  expect(t.player(ada).mass).toBe(1);
});
```

`npm run check && npx vitest run games/bumper`.

## Growing the game

- obstacles (pillars, bumpers, moving walls) as static colliders or a `fixed`/`kinematic` body collection in `src/server/physics.ts` — see [PHYSICS.md](../../../docs/PHYSICS.md) and the `gaime-mechanic` skill,
- teams, arena shapes, new game modes — `gaime-mechanic`,
- a new kind of module (arenas, hazards) — `gaime-module-kind`,
- the game's own look and sounds — `gaime-client`.
