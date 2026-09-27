import type { Feature } from '../../shared/types';

export default {
  author: 'gaime',
  description: 'Coins and a rare gem.',
  pickups: [
    { id: 'coin', name: 'Coin', description: 'One point.', value: 1, weight: 10, visual: { shape: 'cylinder', color: '#ffd659', scale: [0.8, 0.15, 0.8], lift: 0.4 } },
    { id: 'gem', name: 'Gem', description: 'Five points, rare.', value: 5, weight: 1, visual: { shape: 'octahedron', color: '#59e3ff', emissive: '#1fa9d6', scale: 0.8, lift: 0.3 } },
  ],
} satisfies Feature;
