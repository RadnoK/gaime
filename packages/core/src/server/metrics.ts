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
}

type LoopDelay = { p50: number; p99: number; max: number };

function metrics(): Metrics {
  if (!store[KEY]) {
    const loop = monitorEventLoopDelay({ resolution: RESOLUTION_MS });
    loop.enable();
    store[KEY] = { tick: [], publish: [], bytes: [], loop, loopSince: Date.now(), loopLast: null, clients: 0, tickRate: 0 };
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

export const recordTick = (ms: number) => { push(metrics().tick, ms); rotate(metrics()); };
export const recordPublish = (ms: number, bytes: number) => { push(metrics().publish, ms); push(metrics().bytes, bytes); };
export const recordClients = (count: number) => { metrics().clients = count; };
export const recordTickRate = (hz: number) => { metrics().tickRate = hz; };

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
    memoryMb: Math.round(process.memoryUsage().rss / 1048576),
  };
}
