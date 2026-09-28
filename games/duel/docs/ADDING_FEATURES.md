# Adding weapons and behaviour to "Duel"

Modules live in `src/features/<id>/server.ts` (picked up automatically). A module can contain:

- `weapons` — `WeaponDef` entries (`src/shared/types.ts`); the weapon bar (keys 1–9) lists every weapon that is not `hidden`;
- `on` — reactions to the game's events (`Events`);
- `modify` — adjustments of the game's numbers (`Modifiers`);
- `systems` — code that runs every tick or every N seconds;
- `commands` — new player actions.

Everything a module does runs isolated: if it throws, only that module is switched off (a ⚠ line in the feed) and the duel goes on. The model behind it: [../../../docs/SIMULATION.md](../../../docs/SIMULATION.md). The event and modifier tables are in [../AGENTS.md](../AGENTS.md#events-srcsharedtypests).

## Prompt to paste to your AI

```text
Read AGENTS.md, docs/SIMULATION.md, games/duel/AGENTS.md, games/duel/docs/ADDING_FEATURES.md and games/duel/src/shared/types.ts.
Author: [name]. Directory: games/duel/src/features/[unique-id]/.
Idea: [e.g. a drill that tunnels through the ground, a bouncing grenade, armour against your own shells].
Add it as a module (weapons / on / modify / systems / commands). Add a test with testGame. Run npm run check and npm test.
Tell me how to use it in the game.
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

## Adding to an impact: `on: { 'shell.impact' }`

Every shell that lands triggers `shell.impact`. The game's own handler explodes it first; your handler runs after it. Filter by `weapon` — the event fires for every shell. This is how `src/features/cluster` adds its bomblets:

```ts
on: {
  'shell.impact': ({ weapon, owner, x, z }, sim) => {
    if (weapon !== 'cluster') return;
    for (let i = 0; i < 5; i++) sim.launch('cluster-bomblet', { x, z: z + 0.5 }, 60 + i * 15, 16, owner);
  },
},
```

The turn waits until every shell — bomblets included — has landed.

## Replacing the explosion: `onImpact`

`onImpact(sim, impact)` replaces the default explosion for that weapon. `impact` is the `shell.impact` payload: position, `owner`, the last velocity (`vx`, `vz`), the struck player (`target`) and a copy of the shell's `data`. If the hook throws, the module is switched off and the shell explodes normally.

```ts
{
  id: 'ola-bouncer', name: 'Bouncer', description: 'Bounces twice before exploding.',
  icon: '◍', color: '#7dff9b', speed: 34, damage: 30, radius: 2.2,
  onImpact(sim, impact) {
    const bounces = Number(impact.data['ola-bounces'] ?? 0);
    if (bounces >= 2 || impact.target) { sim.explode(impact, 2.2, 30, impact.owner, 'ola-bouncer'); return; }
    const shell = sim.launch('ola-bouncer', { x: impact.x, z: sim.heightAt(impact.x) + 0.3 }, impact.vx > 0 ? 60 : 120, Math.hypot(impact.vx, impact.vz) * 0.6, impact.owner);
    shell.data['ola-bounces'] = bounces + 1;
  },
}
```

## Reacting to facts: `on`

```ts
export default {
  author: 'Ola',
  description: 'Vampire shells: the shooter heals half the damage dealt to the opponent.',
  on: {
    'player.hit': ({ player, by, damage }, sim) => {
      const shooter = sim.world.players[by];
      if (shooter && by !== player && shooter.hp > 0) shooter.hp = Math.min(RULES.hp, shooter.hp + Math.round(damage / 2));
    },
  },
} satisfies Feature;
```

Handlers run after the code that triggered the event, in the same tick — the game's first, then modules' in file order. Payloads carry ids: look the player up and check it still exists.

## Changing numbers: `modify`

```ts
export default {
  author: 'Ola',
  description: 'Blast suit: your own shells hurt you half as much.',
  modify: {
    'shell.damage': (damage, { player, by }) => (player === by ? damage * 0.5 : damage),
  },
} satisfies Feature;
```

Each modifier receives the previous result; return the new value (`undefined` keeps it). Available: `shell.damage`, `shell.radius`, `wind.strength` — see `src/features/weather` for a complete behaviour-only module.

## Running code over time: `systems` and timers

```ts
systems: [
  // Every 5 s of game time (staggered with other periodic systems), only during a round.
  { id: 'regen', every: 5, run: sim => {
    if (sim.world.match.phase !== 'playing') return;
    for (const player of sim.fighters()) if (player.hp > 0) player.hp = Math.min(RULES.hp, player.hp + 1);
  } },
],
```

For "later, once" use a timer: `sim.after(seconds, event, data, key)` fires an event (it is saved with the world and survives reloads). Your own events go into `Events` in `src/shared/types.ts`, prefixed with your module id (`'ola-mine.armed': { x: number; z: number }`). Cancel with `sim.cancel(key)`; prefix keys with your module id too.

## New actions: `commands`

```ts
commands: {
  // Pass your turn early: the game's own turn timer, due now.
  'ola-skip': (playerId, _command, sim) => {
    const turns = sim.world.turns;
    if (!turns || turns.order[turns.index] !== playerId || sim.world.turnPhase !== 'aim') return 'Not your turn.';
    sim.after(0, 'turn.expired', { turn: turns.turn }, { key: 'turn:end' });
  },
},
```

A returned string goes back to the player. Validate everything. The client sends it with `net.command({ type: 'ola-skip' } as never)` (module commands are not in the game's `Command` type).

## Rules that keep modules compatible

- Keep state in `projectile.data` / `player.data` (keys prefixed with your module id) or in the world — never in module variables.
- Spawned helper projectiles (bomblets) are weapons too: give them `hidden: true`.
- Damage goes through `sim.explode` so hit numbers, craters, falling, `player.hit` and sounds stay consistent.
- Do not change the turn yourself: the game owns `turns` / `turnPhase`; use its events and the `turn:end` timer.
- Balance: the default shell is speed 38, damage 35, radius 2.6; full HP is 100.

Test a module quickly: `npm run dev -- duel`, `/bot` in chat, press the weapon's number, fire. In tests: `testGame(game, { random: seeded(1) })`, two `t.addBot()` play a whole round (see `tests/simulation.test.ts`).
