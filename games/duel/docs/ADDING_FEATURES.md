# Adding weapons to "Duel"

Weapons are modules: `src/features/<id>/server.ts` with a `weapons` array (`WeaponDef` in `src/shared/types.ts`). The weapon bar (keys 1–9) lists every weapon that is not `hidden`.

## Prompt to paste to your AI

```text
Read AGENTS.md, games/duel/AGENTS.md, games/duel/docs/ADDING_FEATURES.md and games/duel/src/shared/types.ts.
Author: [name]. Directory: games/duel/src/features/[unique-id]/.
Weapon idea: [e.g. a drill that tunnels through the ground, a bouncing grenade, an airstrike].
Add it as a weapon module using WeaponDef and Sim. Run npm run check and npm test.
Tell me which key selects it and how it behaves.
```

## Plain weapons: just numbers

```ts
import type { Feature } from '../../shared/types';

export default {
  author: 'Ola',
  weapons: [{
    id: 'ola-sniper', name: 'Sniper', description: 'Fast, flat, small blast. 2 per round.',
    icon: '➶', color: '#e8f0ff',
    speed: 70,      // launch speed at full power
    damage: 40,
    radius: 1.2,    // explosion + crater radius
    ammo: 2,        // omit for unlimited
    wind: 0.1,      // barely affected by wind
    gravity: 0.4,   // flatter arc
  }],
} satisfies Feature;
```

`count` + `spread` fire several projectiles in a fan (see `scatter` in `src/features/artillery/server.ts`).

## Custom behaviour: `onImpact`

`onImpact(sim, projectile, at)` replaces the default explosion. `Sim` gives you `explode`, `launch`, `heightAt`, `random`, `log`, `emit` and the whole `world`.

```ts
export default {
  author: 'Ola',
  weapons: [
    {
      id: 'ola-bouncer', name: 'Bouncer', description: 'Bounces twice before exploding.',
      icon: '◍', color: '#7dff9b', speed: 34, damage: 30, radius: 2.2,
      onImpact(sim, shell, at) {
        const bounces = Number(shell.data['ola-bounces'] ?? 0);
        if (bounces >= 2) { sim.explode(at, 2.2, 30, shell.owner); return; }
        // Re-launch upwards with less speed; the new projectile inherits the bounce count.
        sim.launch('ola-bouncer', { x: at.x, z: sim.heightAt(at.x) + 0.3 }, shell.vx > 0 ? 60 : 120, Math.hypot(shell.vx, shell.vz) * 0.6, shell.owner);
        const next = Object.values(sim.world.projectiles).at(-1);
        if (next) next.data['ola-bounces'] = bounces + 1;
      },
    },
  ],
} satisfies Feature;
```

Rules that keep weapons compatible:

- Keep all state in `projectile.data` (prefix keys with your module id) or in the world — never in module variables.
- Spawned helper projectiles (bomblets) are weapons too: give them `hidden: true`.
- Damage goes through `sim.explode` so hit numbers, craters, falling and sounds stay consistent.
- Balance: the default shell is speed 38, damage 35, radius 2.6; full HP is 100.

Test a weapon quickly: `npm run dev -- duel`, `/bot` in chat, press the weapon's number, fire.
