import { dist } from '@gaime/core';
import type { Feature } from '../../shared/types';

const SLAM_RADIUS = 5;

/**
 * Example of a boss with a periodic module system (`every`), its own wave, a death hook
 * and a custom 3D model (see client.ts in this directory: shape "golem").
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
    // No `tick`: the golem walks with the default AI; the slam is the system below.
    onDeath(sim, golem) {
      for (let i = 0; i < 3; i++) sim.spawn('beetle', { x: golem.x + (sim.random() - 0.5) * 3, z: golem.z + (sim.random() - 0.5) * 3 });
      sim.log('🪨 The golem crumbles!');
    },
  }],
  systems: [{
    // Runs every 6 s of game time (staggered against other periodic systems), not every tick.
    id: 'slam',
    every: 6,
    run(sim) {
      if (sim.world.phase !== 'fight') return;
      for (const golem of sim.enemies()) {
        if (golem.kind !== 'golem') continue;
        sim.effect('pulse', golem, { radius: SLAM_RADIUS, color: '#8f7bff' });
        for (const player of sim.players()) if (dist(golem, player) <= SLAM_RADIUS) sim.hurtPlayer(player, 30, 'golem');
      }
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
