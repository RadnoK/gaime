import { status } from '@gaime/core/kit';
import type { Feature } from '../../shared/types';

// A module without definitions: pure behaviour, reacting to the game's events.
export default {
  author: 'gaime',
  description: 'Combo: a pickup collected within 2 s of the previous one is worth double.',
  on: {
    'pickup.collected': ({ playerId }, sim) => {
      const player = sim.world.players[playerId];
      // Timed per-player state lives in `data` (saved, hot-reload safe, visible to the client).
      if (player) status.apply(player.data, 'combo', sim.world.time, 2);
    },
  },
  modify: {
    'pickup.points': (points, { playerId }, sim) => {
      const player = sim.world.players[playerId];
      return player && status.active(player.data, 'combo', sim.world.time) ? points * 2 : points;
    },
  },
} satisfies Feature;
