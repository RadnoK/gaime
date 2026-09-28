import type { Feature } from '../../shared/types';

// A module without definitions: it adjusts a value (`modify`) and reacts to an event (`on`).
export default {
  author: 'gaime',
  description: 'Weather: the opening turn of a round is calmer, every fourth turn brings a gust.',
  modify: {
    'wind.strength': (wind, { turn }) => (turn === 1 ? wind * 0.5 : turn % 4 === 0 ? wind * 1.5 : wind),
  },
  on: {
    'turn.started': ({ turn, wind }, sim) => {
      if (turn % 4 === 0 && Math.abs(wind) >= 1) sim.log(`💨 Gust! Wind ${wind > 0 ? '→' : '←'} ${Math.abs(wind).toFixed(1)}`);
    },
  },
} satisfies Feature;
