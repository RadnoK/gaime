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
  clients: number;
}

function metrics(): Metrics {
  if (!store[KEY]) {
    const loop = monitorEventLoopDelay({ resolution: RESOLUTION_MS });
    loop.enable();
    store[KEY] = { tick: [], publish: [], bytes: [], loop, clients: 0 };
  }
  return store[KEY]!;
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

export const recordTick = (ms: number) => push(metrics().tick, ms);
export const recordPublish = (ms: number, bytes: number) => { push(metrics().publish, ms); push(metrics().bytes, bytes); };
export const recordClients = (count: number) => { metrics().clients = count; };

export function stats() {
  const m = metrics();
  // The histogram measures whole sampling intervals: subtract the interval to get the delay.
  const delay = (ns: number) => Math.max(0, ns / 1e6 - RESOLUTION_MS);
  const loop = { p50: delay(m.loop.percentile(50)), p99: delay(m.loop.percentile(99)), max: delay(m.loop.max) };
  m.loop.reset();
  return {
    clients: m.clients,
    tickMs: summary(m.tick),
    publishMs: summary(m.publish),
    patchBytes: summary(m.bytes),
    eventLoopDelayMs: Object.fromEntries(Object.entries(loop).map(([k, v]) => [k, Math.round(v * 100) / 100])),
    memoryMb: Math.round(process.memoryUsage().rss / 1048576),
  };
}
