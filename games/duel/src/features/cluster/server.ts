import type { Feature } from '../../shared/types';

/** Example of a weapon with custom impact logic: it bursts into bomblets. */
export default {
  author: 'gaime',
  description: 'Cluster bomb and its bomblets.',
  weapons: [
    {
      id: 'cluster', name: 'Cluster bomb', description: 'Bursts into five bomblets on impact. 1 per round.',
      icon: '✺', color: '#b481ff', speed: 34, damage: 15, radius: 1.5, ammo: 1,
      onImpact(sim, projectile, at) {
        sim.explode(at, 1.5, 15, projectile.owner);
        for (let i = 0; i < 5; i++) sim.launch('cluster-bomblet', { x: at.x, z: at.z + 0.5 }, 60 + i * 15 + (sim.random() - 0.5) * 10, 14 + sim.random() * 6, projectile.owner);
      },
    },
    {
      id: 'cluster-bomblet', name: 'Bomblet', description: 'Spawned by the cluster bomb.',
      icon: '•', color: '#b481ff', speed: 1, damage: 14, radius: 1.6, hidden: true,
    },
  ],
} satisfies Feature;
