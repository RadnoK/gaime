import { status } from '@gaime/core/kit';
import type { Feature } from '../../shared/types';

// A module without definitions: pure behaviour, reacting to the game's events.
export default {
  author: 'gaime',
  description: 'Streak: pushing someone off the arena gives you a 3-second speed burst.',
  on: {
    'player.knocked': ({ by }, sim) => {
      const pusher = by ? sim.world.players[by] : undefined;
      // Timed per-player state lives in `data` (saved, hot-reload safe, visible to the client).
      if (pusher?.alive) status.apply(pusher.data, 'streak', sim.world.time, 3);
    },
  },
  modify: {
    'move.accel': (accel, { player }, sim) => {
      const data = sim.world.players[player]?.data;
      return data && status.active(data, 'streak', sim.world.time) ? accel * 1.3 : accel;
    },
  },
} satisfies Feature;
