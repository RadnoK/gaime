import { clampToArena } from '../../shared/rules';
import type { Feature } from '../../shared/types';
import { dist } from '@gaime/core';

export default {
  author: 'gaime',
  description: 'Starting abilities for Q/E, and a breather: clearing a wave restores 30 HP to everyone standing.',
  abilities: [
    {
      id: 'dash',
      name: 'Dash',
      description: 'Leap 6 m towards the cursor.',
      cooldown: 4, color: '#59e3ff', icon: '»',
      cast(sim, player, target) {
        const d = dist(player, target) || 1;
        const length = Math.min(6, d);
        const from = { x: player.x, z: player.z };
        player.x += ((target.x - player.x) / d) * length;
        player.z += ((target.z - player.z) / d) * length;
        clampToArena(player);
        sim.effect('tracer', from, { x2: player.x, z2: player.z, color: '#59e3ff' });
      },
    },
    {
      id: 'pulse',
      name: 'Pulse',
      description: '80 damage to every enemy within 6 m.',
      cooldown: 9, color: '#b481ff', icon: '◎',
      cast(sim, player) {
        sim.effect('pulse', player, { radius: 6, color: '#b481ff' });
        for (const enemy of sim.enemies()) if (dist(player, enemy) <= 6) sim.hurtEnemy(enemy, 80, player.id, 'pulse');
      },
    },
    {
      id: 'mend',
      name: 'Mend',
      description: 'Heals you and players within 5 m by 40 HP.',
      cooldown: 14, color: '#59ffb0', icon: '✚',
      cast(sim, player) {
        sim.effect('pulse', player, { radius: 5, color: '#59ffb0' });
        for (const other of sim.players()) if (dist(player, other) <= 5) sim.heal(other, 40);
      },
    },
  ],
  // Example of `on`: react to a game event without touching the game's code.
  on: {
    'wave.cleared': (_event, sim) => {
      for (const player of sim.players()) {
        sim.heal(player, 30);
        sim.effect('text', player, { text: '+30', color: '#59ffb0' });
      }
    },
  },
} satisfies Feature;
