/**
 * Turn order for turn-based games (artillery, board and card games). Plain data in World.
 *
 *   world.turns = createTurns(playerIds, world.time, 30);
 *   if (isTurnOf(world.turns, playerId)) …
 *   if (turnExpired(world.turns, world.time)) nextTurn(world.turns, world.time, 30);
 */
export interface TurnState {
  /** Player (or team) ids in play order. */
  order: string[];
  index: number;
  /** 1-based count of turns played this round. */
  turn: number;
  /** World time when the current turn times out (0 = no limit). */
  endsAt: number;
  /** Frozen seconds left while paused (e.g. a projectile in flight). */
  frozen: number | null;
}

export function createTurns(order: string[], time: number, seconds: number, first = 0): TurnState {
  return { order: [...order], index: Math.max(0, Math.min(first, order.length - 1)), turn: 1, endsAt: seconds ? time + seconds : 0, frozen: null };
}

export function currentTurn(turns: TurnState): string | undefined {
  return turns.order[turns.index];
}

export function isTurnOf(turns: TurnState, id: string) {
  return turns.frozen === null && turns.order[turns.index] === id;
}

export function turnTimeLeft(turns: TurnState, time: number) {
  if (turns.frozen !== null) return turns.frozen;
  return turns.endsAt ? Math.max(0, turns.endsAt - time) : Infinity;
}

export function turnExpired(turns: TurnState, time: number) {
  return turns.frozen === null && turns.endsAt > 0 && time >= turns.endsAt;
}

/**
 * Pass the turn to the next id for which `canPlay` is true (default: everyone).
 * Returns the new current id, or undefined when nobody can play.
 */
export function nextTurn(turns: TurnState, time: number, seconds: number, canPlay: (id: string) => boolean = () => true): string | undefined {
  for (let step = 1; step <= turns.order.length; step++) {
    const index = (turns.index + step) % turns.order.length;
    if (!canPlay(turns.order[index])) continue;
    turns.index = index;
    turns.turn++;
    turns.endsAt = seconds ? time + seconds : 0;
    turns.frozen = null;
    return turns.order[index];
  }
  return undefined;
}

/** Stop the clock (e.g. while a shot resolves); `resumeTurn` continues it. */
export function freezeTurn(turns: TurnState, time: number) {
  if (turns.frozen === null) turns.frozen = turnTimeLeft(turns, time) === Infinity ? 0 : turnTimeLeft(turns, time);
}

export function resumeTurn(turns: TurnState, time: number, atLeast = 0) {
  if (turns.frozen === null) return;
  const left = Math.max(turns.frozen, atLeast);
  turns.endsAt = (turns.endsAt || left) ? time + left : 0;
  turns.frozen = null;
}

/** Keep the order in sync with who is still in the game (players leaving mid-round). */
export function syncTurns(turns: TurnState, ids: string[]) {
  const current = currentTurn(turns);
  turns.order = turns.order.filter(id => ids.includes(id));
  for (const id of ids) if (!turns.order.includes(id)) turns.order.push(id);
  const index = current ? turns.order.indexOf(current) : -1;
  turns.index = index >= 0 ? index : Math.min(turns.index, Math.max(0, turns.order.length - 1));
}
