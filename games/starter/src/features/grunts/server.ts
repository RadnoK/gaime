import type { Feature } from '../../shared/types';

export default {
  author: 'gaime',
  description: 'Basic enemies: a slow beetle and a fast runner.',
  enemies: [
    {
      id: 'beetle',
      name: 'Beetle',
      description: 'Slow and tough. Walks straight to the crystal unless someone gets in its way.',
      hp: 60, speed: 2.2, radius: 0.7, damage: 14, reward: 10,
      visual: { shape: 'sphere', color: '#ff7a59', scale: [1.4, 0.9, 1.6] },
    },
    {
      id: 'runner',
      name: 'Runner',
      description: 'Fast and fragile. Comes in groups.',
      hp: 24, speed: 4.6, radius: 0.45, damage: 8, reward: 6,
      visual: { shape: 'cone', color: '#ffd659', scale: [0.8, 1.1, 0.8] },
    },
  ],
} satisfies Feature;
