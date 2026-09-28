import { status } from '@gaime/core/kit';
import type { Feature } from '../../shared/types';

// A powerup plus the rule that gives it meaning: while the status is on, the disc is three times as dense.
export default {
  author: 'gaime',
  description: 'Anvil: a heavy disc for a few seconds — pushes like a truck, hardly moves when hit.',
  powerups: [
    { id: 'anvil', name: 'Anvil', description: 'Triple mass for 6 s.', weight: 2, duration: 6, visual: { shape: 'box', color: '#9aa7b8', scale: 0.7, lift: 0.5 } },
  ],
  modify: {
    'push.mass': (mass, { player }, sim) => (status.active(sim.world.players[player]?.data ?? {}, 'powerup:anvil', sim.world.time) ? mass * 3 : mass),
  },
} satisfies Feature;
