import type { Feature } from '../../shared/types';

/**
 * A weapon with extra impact behaviour: the game explodes the cluster shell like any other
 * (damage 15, radius 1.5), and this module's `shell.impact` handler adds five bomblets.
 */
export default {
  author: 'gaime',
  description: 'Cluster bomb and its bomblets.',
  weapons: [
    {
      id: 'cluster', name: 'Cluster bomb', description: 'Bursts into five bomblets on impact. 1 per round.',
      icon: '✺', color: '#b481ff', speed: 34, damage: 15, radius: 1.5, ammo: 1,
    },
    {
      id: 'cluster-bomblet', name: 'Bomblet', description: 'Spawned by the cluster bomb.',
      icon: '•', color: '#b481ff', speed: 1, damage: 14, radius: 1.6, hidden: true,
    },
  ],
  on: {
    'shell.impact': ({ weapon, owner, x, z }, sim) => {
      if (weapon !== 'cluster') return;
      for (let i = 0; i < 5; i++) sim.launch('cluster-bomblet', { x, z: z + 0.5 }, 60 + i * 15 + (sim.random() - 0.5) * 10, 14 + sim.random() * 6, owner);
    },
  },
} satisfies Feature;
