import { dist } from '@gaime/core';
import type { Feature } from '../../shared/types';

/**
 * Example of a boss with its own AI (`tick`), its own wave and a custom 3D model
 * (see client.ts in this directory: shape "golem").
 */
export default {
  author: 'gaime',
  description: 'Golem — a boss with its own 3D model and an area attack.',
  enemies: [{
    id: 'golem',
    name: 'Golem',
    description: 'Slams the ground every 6 s: 30 damage to players within 5 m. Breaks into three beetles when it dies.',
    hp: 900, speed: 1.4, radius: 1.6, damage: 40, reward: 150,
    visual: { shape: 'golem', color: '#8f7bff', scale: 1.6 },
    tick(sim, golem) {
      const slamAt = Number(golem.data['golem-slam-at'] ?? sim.world.time + 6);
      if (sim.world.time >= slamAt) {
        sim.effect('pulse', golem, { radius: 5, color: '#8f7bff' });
        for (const player of sim.players()) if (dist(golem, player) <= 5) sim.hurtPlayer(player, 30);
        golem.data['golem-slam-at'] = sim.world.time + 6;
      } else golem.data['golem-slam-at'] = slamAt;
      sim.defaultAi(golem);
    },
    onDeath(sim, golem) {
      for (let i = 0; i < 3; i++) sim.spawn('beetle', { x: golem.x + (sim.random() - 0.5) * 3, z: golem.z + (sim.random() - 0.5) * 3 });
      sim.log('🪨 The golem crumbles!');
    },
  }],
  waves: [{
    id: 'golem-march',
    name: 'Golem march',
    description: 'A golem escorted by beetles. From wave 3.',
    minWave: 3,
    start(sim, wave) {
      sim.spawn('golem', { count: wave >= 6 ? 2 : 1, interval: 6 });
      sim.spawn('beetle', { count: 4 + wave, delay: 2, interval: 1 });
    },
  }],
} satisfies Feature;
