import { status } from '@gaime/core/kit';
import type { Feature } from '../../shared/types';

const active = (data: Record<string, number | string | boolean> | undefined, time: number) => !!data && status.active(data, 'powerup:turbo', time);

// A powerup with a hook: collecting it also gives an instant kick in the direction the disc rolls.
export default {
  author: 'gaime',
  description: 'Turbo: faster steering and stronger dashes for a while.',
  powerups: [
    {
      id: 'turbo', name: 'Turbo', description: '+60% acceleration and dash power for 5 s.', weight: 3, duration: 5,
      visual: { shape: 'octahedron', color: '#ffd659', emissive: '#b8860b', scale: 0.7, lift: 0.5 },
      onCollect(sim, player) {
        const speed = Math.hypot(player.vx, player.vz);
        if (speed > 0.5) sim.push(player.id, { x: (player.vx / speed) * 4 * player.mass, z: (player.vz / speed) * 4 * player.mass });
      },
    },
  ],
  modify: {
    'move.accel': (accel, { player }, sim) => (active(sim.world.players[player]?.data, sim.world.time) ? accel * 1.6 : accel),
    'dash.power': (power, { player }, sim) => (active(sim.world.players[player]?.data, sim.world.time) ? power * 1.6 : power),
  },
} satisfies Feature;
