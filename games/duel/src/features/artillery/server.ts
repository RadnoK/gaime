import type { Feature } from '../../shared/types';

export default {
  author: 'gaime',
  description: 'Standard artillery.',
  weapons: [
    {
      id: 'shell', name: 'Shell', description: 'Reliable all-rounder. Unlimited.',
      icon: '●', color: '#ffd659', speed: 38, damage: 35, radius: 2.6,
    },
    {
      id: 'mortar', name: 'Mortar', description: 'Heavy, slow, big crater. 2 per round; barely affected by wind.',
      icon: '⬤', color: '#ff7a59', speed: 30, damage: 55, radius: 4.2, ammo: 2, wind: 0.3, gravity: 1.2,
    },
    {
      id: 'scatter', name: 'Scatter', description: 'Three small shells in a fan. 3 per round.',
      icon: '⁂', color: '#b0ff59', speed: 36, damage: 16, radius: 1.8, ammo: 3, count: 3, spread: 12,
    },
  ],
} satisfies Feature;
