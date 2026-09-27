/**
 * Round lifecycle shared by most session games:
 *
 *   lobby ──(enough players ready)──▶ countdown ──▶ playing ──(endMatch)──▶ ended ──(rematch)──▶ lobby
 *
 * Plain data: keep `match` in your World. Call `stepMatch` every tick; it tells you
 * when the round must start, so your `step` can reset positions, deal cards, etc.
 */
export type MatchPhase = 'lobby' | 'countdown' | 'playing' | 'ended';

export interface MatchState {
  phase: MatchPhase;
  round: number;
  /** Player id → ready. Only players listed here count as ready. */
  ready: Record<string, boolean>;
  /** Countdown end (countdown) or round end (playing, when a duration is set). */
  until: number;
  startedAt: number;
  endedAt: number;
  /** Winner id, team, or null for a draw. */
  winner: string | null;
  /** Human readable reason (`'time'`, `'last standing'`…). */
  reason: string;
}

export interface MatchRules {
  /** Players needed to start. Default 1. */
  minPlayers?: number;
  /** Seconds between "everyone is ready" and the start. Default 3 (0 = immediately). */
  countdown?: number;
  /** Round length in seconds; the round ends with `reason: 'time'`. Default: no limit. */
  duration?: number;
  /** Start as soon as `minPlayers` are present, without ready clicks. Default false. */
  autoStart?: boolean;
  /** Seconds on the result screen before going back to the lobby by itself. Default: stay. */
  resultSeconds?: number;
}

export type MatchEvent = 'countdown' | 'cancelled' | 'start' | 'timeout' | 'lobby' | undefined;

export function createMatch(): MatchState {
  return { phase: 'lobby', round: 0, ready: {}, until: 0, startedAt: 0, endedAt: 0, winner: null, reason: '' };
}

export function setReady(match: MatchState, playerId: string, ready = true) {
  if (match.phase !== 'lobby' && match.phase !== 'countdown' && match.phase !== 'ended') return;
  if (ready) match.ready[playerId] = true; else delete match.ready[playerId];
}

/**
 * Advance the lifecycle. `present` = ids of players that take part (online, not spectators).
 * Returns what happened this tick, so the game can react exactly once.
 */
export function stepMatch(match: MatchState, time: number, present: string[], rules: MatchRules = {}): MatchEvent {
  const min = rules.minPlayers ?? 1;
  for (const id of Object.keys(match.ready)) if (!present.includes(id)) delete match.ready[id];
  const allReady = present.length >= min && (rules.autoStart || present.every(id => match.ready[id]));

  if (match.phase === 'lobby' && allReady) {
    const seconds = rules.countdown ?? 3;
    if (seconds <= 0) return start(match, time, rules);
    match.phase = 'countdown';
    match.until = time + seconds;
    return 'countdown';
  }
  if (match.phase === 'countdown') {
    if (!allReady) { match.phase = 'lobby'; return 'cancelled'; }
    if (time >= match.until) return start(match, time, rules);
  }
  if (match.phase === 'playing' && rules.duration && time >= match.until) {
    endMatch(match, time, null, 'time');
    return 'timeout';
  }
  if (match.phase === 'ended' && rules.resultSeconds !== undefined && time >= match.endedAt + rules.resultSeconds) {
    toLobby(match);
    return 'lobby';
  }
  return undefined;
}

function start(match: MatchState, time: number, rules: MatchRules): MatchEvent {
  match.phase = 'playing';
  match.round++;
  match.startedAt = time;
  match.until = rules.duration ? time + rules.duration : 0;
  match.winner = null;
  match.reason = '';
  match.ready = {};
  return 'start';
}

export function endMatch(match: MatchState, time: number, winner: string | null, reason = '') {
  if (match.phase !== 'playing') return;
  match.phase = 'ended';
  match.endedAt = time;
  match.winner = winner;
  match.reason = reason;
}

/** Back to the lobby (e.g. "rematch" once everyone clicked ready again, or after the result screen). */
export function toLobby(match: MatchState) {
  match.phase = 'lobby';
  match.ready = {};
}

/** Seconds left in the countdown or round (0 when not applicable). */
export function matchTimeLeft(match: MatchState, time: number) {
  const timed = match.phase === 'countdown' || (match.phase === 'playing' && match.until > 0);
  return timed ? Math.max(0, match.until - time) : 0;
}
