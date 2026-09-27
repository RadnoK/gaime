import { dist } from '@gaime/core';
import type { Feature } from '../../shared/types';

export default {
  author: 'gaime',
  description: 'Example of a module added while the game runs: a slowing ability.',
  abilities: [{
    id: 'frost-nova',
    name: 'Frost',
    description: 'Slows enemies within 7 m by 80% for 3 s and deals 20 damage.',
    cooldown: 12, color: '#9fe8ff', icon: '❄',
    cast(sim, player) {
      sim.effect('pulse', player, { radius: 7, color: '#9fe8ff' });
      for (const enemy of sim.enemies()) {
        if (dist(player, enemy) > 7) continue;
        sim.slow(enemy, 0.2, 3);
        sim.hurtEnemy(enemy, 20, player.id);
      }
    },
  }],
} satisfies Feature;
