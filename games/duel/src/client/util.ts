import type { Player, World } from '../shared/types';

/** Seated players, left first (client-side twin of the server's `fighters`). */
export function fightersOf(world: World): Player[] {
  return Object.values(world.players).filter(p => p.seat >= 0).sort((a, b) => a.seat - b.seat);
}

export function activeId(world: World) {
  return world.turns?.order[world.turns.index];
}
