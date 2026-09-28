import { dist } from '@gaime/core';
import { status } from '@gaime/core/kit';
import type { Feature } from '../../shared/types';

/** Example of `modify`: the chill is a status in `enemy.data`; the module itself changes the enemies' speed. */
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
        status.apply(enemy.data, 'frost-chill', sim.world.time, 3);
        sim.hurtEnemy(enemy, 20, player.id, 'frost-nova');
      }
    },
  }],
  modify: {
    // Every enemy movement asks `sim.enemySpeed(enemy)`, which runs this.
    'enemy.speed': (speed, { enemy }, sim) => {
      const data = sim.world.enemies[enemy]?.data;
      return data && status.active(data, 'frost-chill', sim.world.time) ? speed * 0.2 : speed;
    },
  },
} satisfies Feature;
