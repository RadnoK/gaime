# Adding features to "Blank"

Everything new goes into its own module: a directory `src/features/<id>/` with a `server.ts`. A module can add **content** (pickups) and **behaviour** (`on`, `modify`, `systems`, `commands`) — or both. Save the file and the dev server picks it up while the game runs. The API is listed in [../AGENTS.md](../AGENTS.md) (events, modifiers, `Sim`, `PickupDef`); the model behind it in [SIMULATION.md](../../../docs/SIMULATION.md).

Prompt to paste into your AI:

```text
Read AGENTS.md, docs/SIMULATION.md and games/blank/AGENTS.md. Author: <name>. In
games/blank/src/features/<name>-<idea>/server.ts add <what>. Use the game's events
(pickup.spawned, pickup.collected, pickup.expired), the pickup.points modifier and the Sim
helpers; no edits outside that directory except a test. Add a testGame test in
games/blank/tests/, run npm run check and npx vitest run games/blank, and tell me how to see it.
```

## A new pickup

```ts
// src/features/ola-star/server.ts
import type { Feature } from '../../shared/types';

export default {
  author: 'Ola',
  description: 'A rare star that also sends you back to the centre.',
  pickups: [{
    id: 'ola-star',
    name: 'Star',
    description: 'Ten points, and back to the centre.',
    value: 10,
    weight: 0.5,                       // relative spawn chance (coins have 10)
    life: 8,                           // disappears after 8 s (default RULES.pickupLife = 20)
    visual: { shape: 'octahedron', color: '#ffe066', emissive: '#aa8800', scale: 0.9, lift: 0.4 },
    onPickup(sim, player) {            // optional extra effect, runs isolated under this module
      player.x = 0; player.z = 0;
      sim.log(`${player.name} found a star!`);
    },
  }],
} satisfies Feature;
```

Ids are global and stable — prefix them with your name. `visual.shape` is a built-in primitive (`box`, `sphere`, `capsule`, `cone`, `cylinder`, `torus`, `octahedron`, `ring`) or a custom model registered from a module's `client.ts` ([MODULES.md](../../../docs/MODULES.md#clientts-custom-models)). `onPickup(sim, player, pickup)` runs when the pickup is collected, before the `pickup.collected` handlers; if it throws, only this module is switched off.

## Behaviour: `on`, `modify`, `systems`, `commands`

`src/features/combo/server.ts` is the built-in example of a behaviour-only module: it reacts to `pickup.collected` (`on`) and doubles `pickup.points` for two seconds (`modify`). A bigger one using all four keys:

```ts
// src/features/ola-rush/server.ts
import { cooldown } from '@gaime/core/kit';
import type { Feature } from '../../shared/types';

export default {
  author: 'Ola',
  description: 'Gold rush: every 10th pickup drops a gem; gems are worth triple near the centre; coin showers; a "home" action.',

  // React to what happens. Payloads carry ids — look things up and check they still exist.
  on: {
    'pickup.collected': ({ playerId }, sim) => {
      const player = sim.world.players[playerId];
      if (!player) return;
      const count = Number(player.data['ola-rush-count'] ?? 0) + 1;   // per-player state in data, prefixed
      player.data['ola-rush-count'] = count;
      if (count % 10 === 0) sim.spawnPickup('gem', { x: player.x + 2, z: player.z });
    },
    'player.joined': ({ player }, sim) => { sim.emit('ola-rush-welcome', undefined, player); },   // an engine event
  },

  // Adjust a value the game computes. Return the new value (undefined keeps it).
  modify: {
    'pickup.points': (points, { playerId, kind }, sim) => {
      const player = sim.world.players[playerId];
      return kind === 'gem' && player && Math.hypot(player.x, player.z) < 5 ? points * 3 : points;
    },
  },

  // Periodic work: the engine runs it every 30 s of game time (not while paused), staggered.
  systems: [
    { id: 'shower', every: 30, run: sim => { for (let i = 0; i < 5; i++) sim.spawnPickup('coin'); } },
  ],

  // A new player action. The client sends net.command({ type: 'ola-rush-home' }).
  commands: {
    'ola-rush-home': (playerId, _command, sim) => {
      const player = sim.world.players[playerId];
      if (!player) return;
      if (!cooldown.use(player.data, 'ola-rush-home', sim.world.time, 20)) return 'Home is recharging.';
      player.x = 0; player.z = 0;
    },
  },
} satisfies Feature;
```

Rules that keep it safe for everyone playing:

- **No state outside the world**: counters and cooldowns live in `player.data` with your prefix; no module-level variables, `setTimeout` or `Date.now()`.
- **Through the `Sim`**: spawn with `sim.spawnPickup` (it sets the expiry timer and triggers `pickup.spawned`), randomness from `sim.random()`, time from `sim.world.time`.
- **Later, once** → a timer: `sim.after(seconds, event, data, { key: 'ola-rush:<id>' })` fires one of the game's `Events` later. Blank's `Sim` accepts only declared events, so a module that needs its own delayed event adds it to `Events` in `src/shared/types.ts` (or asks for a `Sim` helper).
- **Movement speed is predicted by the client** (`movePlayer` in `src/shared/rules.ts`), so it must not come from a modifier; change it in the shared rules instead.
- **Names are global**: command types `<module>-<action>`, system ids unique in your module, data keys prefixed.
- **Errors switch your module off**, not the game: a ⚠ line in the feed and `disabled` in `/health` until a fix is pushed. Tests are strict and throw instead.

A module can add a sound for its own client event (`ola-rush-welcome` above) in `src/client/main.ts` with `net.on('event', …)`; how anything looks or sounds is the game's design — the default HUD and scene are placeholders.

## Test it

```ts
// tests/ola-rush.test.ts
import { expect, test } from 'vitest';
import { seeded } from '@gaime/core';
import { testGame } from '@gaime/core/server';
import { game } from '../src/server/game';

test('every 10th pickup drops a gem', () => {
  const t = testGame(game, { random: seeded(1) });
  const ada = t.join('Ada');
  for (let i = 0; i < 10; i++) { t.act(sim => sim.spawnPickup('coin', t.player(ada))); t.tick(); }
  expect(Object.values(t.world.pickups).some(p => p.kind === 'gem')).toBe(true);
  expect(t.command(ada, { type: 'ola-rush-home' })).toBeUndefined();
  expect(t.command(ada, { type: 'ola-rush-home' })).toMatch(/recharging/);
});
```

`npm run check && npx vitest run games/blank`.

## Growing the game

Blank is deliberately tiny. Typical next steps, each with a skill in `.claude/skills/`:

- a new mechanic (health, shooting, rounds) with its own events and modifiers — `gaime-mechanic`,
- a new kind of module (enemies, weapons, power-ups) — `gaime-module-kind`,
- the game's own look: HUD, scene, sounds — `gaime-client`,
- heavy computation — `gaime-worker`.

The kit (`@gaime/core/kit`) already has collisions, raycasts, projectiles, cooldowns and statuses, match lifecycle, turns, inventories and teams — see [KIT.md](../../../docs/KIT.md).
