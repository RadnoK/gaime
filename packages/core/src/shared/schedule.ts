/**
 * The engine's timer queue: a binary min-heap over plain JSON, stored in `world.schedule`,
 * so timers survive hot reloads, checkpoints and restarts, and cost O(log n) instead of
 * a check per entity per tick. A due timer fires its event on the event bus.
 *
 * Every timer has a key (given, or generated from its id). Scheduling a key again
 * replaces the timer; cancelling removes it. Cancelled entries stay in the heap until
 * they surface (checked against `live`) or the heap is compacted.
 */
export interface Timer {
  id: number;
  key: string;
  /** World time when it fires. */
  at: number;
  event: string;
  /** JSON payload passed to the event handlers. */
  data?: unknown;
  /** Repeat interval in seconds (recurring timers). */
  every?: number;
  /** Remaining firings of a recurring timer; absent = forever. */
  left?: number;
}

export interface Schedule {
  next: number;
  /** Number of live timers (keys in `live`). */
  size: number;
  heap: Timer[];
  /** key → the live timer with that key (id, time, event, interval). */
  live: Record<string, { id: number; at: number; event: string; every?: number }>;
}

export interface TimerOptions {
  /** Stable name: scheduling the same key again replaces the timer. Prefix with your module id. */
  key?: string;
  /** Repeat every N seconds after the first firing. */
  every?: number;
  /** With `every`: stop after this many firings. */
  times?: number;
}

export function createSchedule(): Schedule {
  return { next: 1, size: 0, heap: [], live: {} };
}

const before = (a: Timer, b: Timer) => a.at < b.at || (a.at === b.at && a.id < b.id);

function up(heap: Timer[], index: number) {
  const item = heap[index];
  while (index > 0) {
    const parent = (index - 1) >> 1;
    if (!before(item, heap[parent])) break;
    heap[index] = heap[parent];
    index = parent;
  }
  heap[index] = item;
}

function down(heap: Timer[], index: number) {
  const item = heap[index];
  const size = heap.length;
  for (;;) {
    let child = index * 2 + 1;
    if (child >= size) break;
    if (child + 1 < size && before(heap[child + 1], heap[child])) child++;
    if (!before(heap[child], item)) break;
    heap[index] = heap[child];
    index = child;
  }
  heap[index] = item;
}

function forget(schedule: Schedule, key: string) {
  if (!schedule.live[key]) return false;
  delete schedule.live[key];
  schedule.size--;
  return true;
}

function push(schedule: Schedule, timer: Timer) {
  schedule.heap.push(timer);
  up(schedule.heap, schedule.heap.length - 1);
  if (!schedule.live[timer.key]) schedule.size++;
  schedule.live[timer.key] = timer.every ? { id: timer.id, at: timer.at, event: timer.event, every: timer.every } : { id: timer.id, at: timer.at, event: timer.event };
}

function pop(heap: Timer[]): Timer | undefined {
  const top = heap[0];
  const last = heap.pop();
  if (heap.length && last) { heap[0] = last; down(heap, 0); }
  return top;
}

const isLive = (schedule: Schedule, timer: Timer) => schedule.live[timer.key]?.id === timer.id;

/** Drop cancelled entries once they make up most of the heap. */
function compact(schedule: Schedule) {
  if (schedule.heap.length < 64 || schedule.heap.length < schedule.size * 2) return;
  schedule.heap = schedule.heap.filter(timer => isLive(schedule, timer));
  for (let i = (schedule.heap.length >> 1) - 1; i >= 0; i--) down(schedule.heap, i);
}

/** Schedules `event` at `now + delay`. Returns the timer key. */
export function addTimer(schedule: Schedule, now: number, delay: number, event: string, data?: unknown, options: TimerOptions = {}): string {
  const id = schedule.next++;
  const key = options.key ?? `#${id}`;
  const every = options.every !== undefined && options.every > 0 ? options.every : undefined;
  const timer: Timer = { id, key, at: now + Math.max(0, Number.isFinite(delay) ? delay : 0), event };
  if (data !== undefined) timer.data = data;
  if (every) timer.every = every;
  if (every && options.times !== undefined) timer.left = Math.max(1, Math.floor(options.times));
  push(schedule, timer);
  compact(schedule);
  return key;
}

export function cancelTimer(schedule: Schedule, key: string): boolean {
  if (!forget(schedule, key)) return false;
  compact(schedule);
  return true;
}

/** Cancels every timer whose key starts with `prefix` (e.g. all timers of one entity). */
export function cancelTimers(schedule: Schedule, prefix: string): number {
  let count = 0;
  for (const key of Object.keys(schedule.live)) if (key.startsWith(prefix) && forget(schedule, key)) count++;
  if (count) compact(schedule);
  return count;
}

/** Seconds until the timer fires, or undefined when there is no such timer. */
export function timerLeft(schedule: Schedule, key: string, now: number): number | undefined {
  const live = schedule.live[key];
  return live ? Math.max(0, live.at - now) : undefined;
}

/** Number of live timers, optionally only those whose key starts with `prefix`. */
export function countTimers(schedule: Schedule, prefix = ''): number {
  if (!prefix) return schedule.size;
  let count = 0;
  for (const key in schedule.live) if (key.startsWith(prefix)) count++;
  return count;
}

/**
 * Removes and returns every timer due at `now`, in (time, creation) order. Recurring
 * timers are put back; one that missed several intervals (a pause, a slow tick) fires
 * once and continues a full interval after `now`.
 */
export function takeDue(schedule: Schedule, now: number, limit = Infinity): Timer[] {
  const due: Timer[] = [];
  const heap = schedule.heap;
  while (heap.length && heap[0].at <= now && due.length < limit) {
    const timer = pop(heap)!;
    if (!isLive(schedule, timer)) continue;
    due.push(timer);
    if (timer.every && (timer.left === undefined || timer.left > 1)) {
      const next: Timer = { ...timer, at: timer.at + timer.every <= now ? now + timer.every : timer.at + timer.every };
      if (next.left !== undefined) next.left--;
      push(schedule, next);
    } else {
      forget(schedule, timer.key);
    }
  }
  return due;
}
