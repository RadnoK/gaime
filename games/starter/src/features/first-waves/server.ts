import type { Feature } from '../../shared/types';

export default {
  author: 'gaime',
  description: 'Basic attacks rotating between waves.',
  waves: [
    {
      id: 'swarm',
      name: 'Swarm',
      description: 'Beetles and runners from every side. Grows with each wave.',
      weight: 3,
      start(sim, wave) {
        sim.spawn('beetle', { count: 3 + wave * 2, interval: 0.8 });
        sim.spawn('runner', { count: 2 + wave * 2, delay: 3, interval: 0.4 });
      },
    },
    {
      id: 'stampede',
      name: 'Stampede',
      description: 'A wall of runners from one direction.',
      minWave: 2,
      start(sim, wave) {
        const angle = sim.random() * Math.PI * 2;
        for (let i = 0; i < 6 + wave * 3; i++) {
          const spread = angle + (sim.random() - 0.5) * 0.6;
          sim.spawn('runner', { x: Math.sin(spread) * 28, z: Math.cos(spread) * 28, delay: i * 0.25 });
        }
      },
    },
  ],
} satisfies Feature;
