/**
 * Time-based helpers that store their state in plain records (a player's
 * `cooldowns`, an entity's `data`), so they survive checkpoints and hot reloads.
 * `time` is always `world.time` (seconds). Never use setTimeout for game logic.
 */
type Store = Record<string, number | string | boolean>;

/** Cooldowns keyed by name → ready-at time. Works on a `cooldowns` record or an entity's `data`. */
export const cooldown = {
  ready(store: Store, key: string, time: number) {
    return Number(store[key] ?? 0) <= time;
  },
  start(store: Store, key: string, time: number, seconds: number) {
    store[key] = time + seconds;
  },
  /** Starts it and returns true when it was ready; returns false otherwise. */
  use(store: Store, key: string, time: number, seconds: number) {
    if (Number(store[key] ?? 0) > time) return false;
    store[key] = time + seconds;
    return true;
  },
  remaining(store: Store, key: string, time: number) {
    return Math.max(0, Number(store[key] ?? 0) - time);
  },
};

/**
 * True once every `interval` seconds. The first call schedules instead of firing,
 * unless `immediately` is set.
 *
 *   if (every(enemy.data, 'golem-slam', world.time, 6)) slam();
 */
export function every(store: Store, key: string, time: number, interval: number, immediately = false): boolean {
  const next = store[key];
  if (typeof next !== 'number') {
    store[key] = time + interval;
    return immediately;
  }
  if (time < next) return false;
  // Keep the cadence when on time; after missed intervals (pauses, lag) fire once, then a full interval later.
  store[key] = next + interval > time ? next + interval : time + interval;
  return true;
}

/** Remember that something should happen at `time + delay`. */
export function schedule(store: Store, key: string, time: number, delay: number) {
  store[key] = time + delay;
}

/** True exactly once when a scheduled moment has passed; clears the schedule. */
export function due(store: Store, key: string, time: number): boolean {
  const at = store[key];
  if (typeof at !== 'number' || time < at) return false;
  delete store[key];
  return true;
}

/** Active effect with an end time (buffs, slows, stuns). */
export const status = {
  apply(store: Store, key: string, time: number, seconds: number, value: number | boolean = true) {
    store[`${key}:until`] = Math.max(Number(store[`${key}:until`] ?? 0), time + seconds);
    store[key] = value;
  },
  active(store: Store, key: string, time: number) {
    return Number(store[`${key}:until`] ?? 0) > time;
  },
  value<V extends number | boolean>(store: Store, key: string, time: number, fallback: V): V {
    return status.active(store, key, time) ? (store[key] as V) : fallback;
  },
  clear(store: Store, key: string) {
    delete store[key]; delete store[`${key}:until`];
  },
};
