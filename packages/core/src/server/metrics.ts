import { monitorEventLoopDelay } from 'node:perf_hooks';

/** Rolling 10-second window of server costs, exposed at `/gaime/stats`. */
const WINDOW = 10_000;
const RESOLUTION_MS = 10;
type Sample = { at: number; value: number };
const KEY = Symbol.for('gaime.metrics');
const store = globalThis as unknown as Record<symbol, Metrics | undefined>;

interface Metrics {
  tick: Sample[];
  publish: Sample[];
  bytes: Sample[];
  loop: ReturnType<typeof monitorEventLoopDelay>;
  /** Start of the current event-loop window and the summary of the last complete one. */
  loopSince: number;
  loopLast: LoopDelay | null;
  clients: number;
  tickRate: number;
  /** Time per system / handler / command: the current window and the last complete one. */
  parts: Map<string, Part>;
  partsLast: Map<string, Part>;
  partsSince: number;
  /** Simulated time the server could not keep up with (catch-up limit), in ms. */
  droppedMs: Sample[];
  engine: EngineCounters;
}

type Part = { calls: number; total: number; max: number };
export type EngineCounters = { events: number; timers: number; timersPending: number; deferredTimers: number; droppedEvents: number };

type LoopDelay = { p50: number; p99: number; max: number };

function metrics(): Metrics {
  if (!store[KEY]) {
    const loop = monitorEventLoopDelay({ resolution: RESOLUTION_MS });
    loop.enable();
    store[KEY] = {
      tick: [], publish: [], bytes: [], loop, loopSince: Date.now(), loopLast: null, clients: 0, tickRate: 0,
      parts: new Map(), partsLast: new Map(), partsSince: Date.now(), droppedMs: [],
      engine: { events: 0, timers: 0, timersPending: 0, deferredTimers: 0, droppedEvents: 0 },
    };
  }
  return store[KEY]!;
}

function readLoop(loop: Metrics['loop']): LoopDelay {
  // The histogram measures whole sampling intervals: subtract the interval to get the delay.
  const delay = (ns: number) => Math.round(Math.max(0, ns / 1e6 - RESOLUTION_MS) * 100) / 100;
  return { p50: delay(loop.percentile(50)), p99: delay(loop.percentile(99)), max: delay(loop.max) };
}

/** The event-loop histogram rolls over every WINDOW, never because somebody read it. */
function rotate(m: Metrics) {
  const now = Date.now();
  if (now - m.loopSince < WINDOW) return;
  m.loopLast = readLoop(m.loop);
  m.loop.reset();
  m.loopSince = now;
}

function push(list: Sample[], value: number) {
  const now = Date.now();
  list.push({ at: now, value });
  while (list.length && list[0].at < now - WINDOW) list.shift();
}

const summary = (list: Sample[]) => {
  if (!list.length) return { avg: 0, max: 0 };
  let sum = 0; let max = 0;
  for (const { value } of list) { sum += value; max = Math.max(max, value); }
  return { avg: Math.round((sum / list.length) * 100) / 100, max: Math.round(max * 100) / 100 };
};

export const recordTick = (ms: number) => {
  const m = metrics();
  push(m.tick, ms);
  rotate(m);
  const now = Date.now();
  if (now - m.partsSince >= WINDOW) { m.partsLast = m.parts; m.parts = new Map(); m.partsSince = now; }
};
export const recordPublish = (ms: number, bytes: number) => { push(metrics().publish, ms); push(metrics().bytes, bytes); };
export const recordClients = (count: number) => { metrics().clients = count; };
export const recordTickRate = (hz: number) => { metrics().tickRate = hz; };
export const recordDropped = (ms: number) => push(metrics().droppedMs, ms);
export const recordEngine = (counters: EngineCounters) => { metrics().engine = counters; };

/** Time spent in one named part of the simulation (a system, an event handler, a command). */
export function recordPart(name: string, ms: number) {
  // Called for every system, handler and command: keep it to one map lookup (windows rotate in recordTick).
  const part = metrics().parts.get(name);
  if (part) { part.calls++; part.total += ms; if (ms > part.max) part.max = ms; }
  else metrics().parts.set(name, { calls: 1, total: ms, max: ms });
}

/** The most expensive parts of the last complete window (or the current one), in ms per second. */
function topParts(m: Metrics, limit = 15) {
  const window = m.partsLast.size ? m.partsLast : m.parts;
  const seconds = Math.max(1, (m.partsLast.size ? WINDOW : Date.now() - m.partsSince) / 1000);
  const round = (n: number) => Math.round(n * 1000) / 1000;
  return [...window.entries()]
    .sort((a, b) => b[1].total - a[1].total)
    .slice(0, limit)
    .map(([name, part]) => ({ name, msPerSecond: round(part.total / seconds), callsPerSecond: round(part.calls / seconds), maxMs: round(part.max) }));
}

export function stats() {
  const m = metrics();
  rotate(m);
  // Worst of the last complete window and the current one (roughly the last 10–20 s).
  const current = readLoop(m.loop);
  const loop = m.loopLast ? { p50: Math.max(m.loopLast.p50, current.p50), p99: Math.max(m.loopLast.p99, current.p99), max: Math.max(m.loopLast.max, current.max) } : current;
  return {
    clients: m.clients,
    tickRate: m.tickRate,
    tickMs: summary(m.tick),
    publishMs: summary(m.publish),
    patchBytes: summary(m.bytes),
    eventLoopDelayMs: loop,
    droppedMs: Math.round(m.droppedMs.reduce((sum, sample) => sum + sample.value, 0)),
    engine: m.engine,
    /** Where the tick time goes: systems, event handlers and commands by module. */
    parts: topParts(m),
    memoryMb: Math.round(process.memoryUsage().rss / 1048576),
  };
}
