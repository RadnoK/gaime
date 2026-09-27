import { Worker } from 'node:worker_threads';
import { availableParallelism } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { WorkerHandlers } from '../worker';

type Handler<H, K extends keyof H> = H[K] extends (payload: infer P) => infer R ? { payload: P; result: Awaited<R> } : never;
type Task = { id: number; task: string; payload: unknown; resolve(value: unknown): void; reject(error: Error): void; timer?: ReturnType<typeof setTimeout>; started: number };
type Slot = { worker: Worker; ready: boolean; task?: Task };

export interface PoolOptions {
  /** Worker threads. Default: min(4, CPU cores - 1), at least 1. */
  size?: number;
  /** Per-task timeout in ms; the worker is replaced when it expires. Default 10 000. */
  timeout?: number;
  /** Game root for `src/workers` (inline mode) — default: the process working directory. */
  root?: string;
}

export interface PoolStats { name: string; size: number; busy: number; queued: number; done: number; failed: number; avgMs: number }

const VITE = Symbol.for('gaime.vite.colyseus');
const KEY = Symbol.for('gaime.workers');
const registry = ((globalThis as Record<symbol, unknown>)[KEY] ??= { generation: 0, pools: new Set<WorkerPool<WorkerHandlers>>() }) as { generation: number; pools: Set<WorkerPool<WorkerHandlers>> };
// This module is evaluated again on every server hot reload: a new code generation.
const generation = ++registry.generation;

type ViteEnv = { hot: { handleInvoke(payload: unknown): Promise<unknown> } };

/**
 * Pool of worker threads running `src/workers/<name>.ts`.
 * - dev (Vite): the worker loads TypeScript through the dev server; editing it hot-swaps the pool,
 * - production: `vite build` bundles it to `dist/server/workers/<name>.mjs`,
 * - tests / no Vite: tasks run inline on the main thread (same results, no parallelism).
 */
export class WorkerPool<H extends WorkerHandlers> {
  readonly generation = generation;
  private readonly slots: Slot[] = [];
  private readonly queue: Task[] = [];
  private inline?: Promise<H>;
  private seq = 0;
  private closed = false;
  private done = 0;
  private failed = 0;
  private totalMs = 0;
  readonly size: number;
  readonly timeout: number;
  private readonly root: string;

  constructor(readonly name: string, options: PoolOptions = {}) {
    this.root = options.root ?? process.cwd();
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error(`Invalid worker name "${name}".`);
    this.size = Math.max(1, options.size ?? Math.min(4, availableParallelism() - 1));
    this.timeout = options.timeout ?? 10_000;
  }

  /** Run `task` with `payload` on a free worker. Rejects on error, timeout or when the pool is replaced. */
  run<K extends keyof H & string>(task: K, payload: Handler<H, K>['payload'], options: { timeout?: number } = {}): Promise<Handler<H, K>['result']> {
    if (this.closed) return Promise.reject(new Error(`Pool "${this.name}" was closed (new code loaded).`));
    return new Promise((resolveTask, rejectTask) => {
      const item: Task = { id: ++this.seq, task, payload, resolve: resolveTask as (value: unknown) => void, reject: rejectTask, started: 0 };
      const timeout = options.timeout ?? this.timeout;
      item.timer = setTimeout(() => this.expire(item), timeout);
      this.queue.push(item);
      this.pump();
    });
  }

  stats(): PoolStats {
    return { name: this.name, size: this.slots.length, busy: this.slots.filter(s => s.task).length, queued: this.queue.length, done: this.done, failed: this.failed, avgMs: this.done ? Math.round(this.totalMs / this.done) : 0 };
  }

  close() {
    this.closed = true;
    for (const task of this.queue.splice(0)) this.settle(task, new Error(`Pool "${this.name}" was closed.`));
    for (const slot of this.slots.splice(0)) {
      if (slot.task) this.settle(slot.task, new Error(`Pool "${this.name}" was closed.`));
      void slot.worker.terminate();
    }
    registry.pools.delete(this as unknown as WorkerPool<WorkerHandlers>);
  }

  private mode(): 'vite' | 'node' | 'inline' {
    if (import.meta.env.PROD) return 'node';
    return (globalThis as Record<symbol, unknown>)[VITE] ? 'vite' : 'inline';
  }

  private pump() {
    if (this.closed) return;
    const mode = this.mode();
    if (mode === 'inline') { while (this.queue.length) void this.runInline(this.queue.shift()!); return; }
    while (this.slots.length < this.size && this.queue.length > this.slots.filter(s => !s.task).length) this.spawn(mode);
    for (const slot of this.slots) {
      if (!slot.ready || slot.task || !this.queue.length) continue;
      const task = this.queue.shift()!;
      slot.task = task;
      task.started = performance.now();
      slot.worker.postMessage({ kind: 'task', id: task.id, task: task.task, payload: task.payload });
    }
  }

  private spawn(mode: 'vite' | 'node') {
    const bootstrap = mode === 'node' ? resolve('dist/server/gaime-worker.mjs') : fileURLToPath(new URL('./worker-bootstrap.mjs', import.meta.url));
    const entry = mode === 'node' ? resolve(`dist/server/workers/${this.name}.mjs`) : `/src/workers/${this.name}.ts`;
    const worker = new Worker(bootstrap, { workerData: { mode, entry, name: this.name } });
    const slot: Slot = { worker, ready: false };
    this.slots.push(slot);
    const env = (globalThis as Record<symbol, ViteEnv | undefined>)[VITE];
    worker.on('message', message => {
      if (message?.kind === 'invoke' && env) {
        void env.hot.handleInvoke(message.payload).then(result => worker.postMessage({ kind: 'invoke-result', id: message.id, result }));
      } else if (message?.kind === 'ready') {
        slot.ready = true;
        this.pump();
      } else if (message?.kind === 'result' || message?.kind === 'error') {
        const task = slot.task;
        if (!task || task.id !== message.id) return;
        slot.task = undefined;
        this.settle(task, message.kind === 'error' ? new Error(`worker ${this.name}.${task.task}: ${message.error}`) : undefined, message.result);
        this.pump();
      }
    });
    worker.on('error', (error: Error) => this.replace(slot, new Error(`worker ${this.name}: ${error.message}`)));
    worker.on('exit', code => { if (this.slots.includes(slot)) this.replace(slot, new Error(`worker ${this.name} exited (${code})`)); });
  }

  private replace(slot: Slot, error: Error) {
    const index = this.slots.indexOf(slot);
    if (index >= 0) this.slots.splice(index, 1);
    if (slot.task) this.settle(slot.task, error);
    void slot.worker.terminate();
    this.pump();
  }

  private expire(task: Task) {
    const slot = this.slots.find(s => s.task === task);
    const error = new Error(`worker ${this.name}.${task.task}: timed out after ${this.timeout} ms`);
    if (slot) { this.replace(slot, error); return; }
    const index = this.queue.indexOf(task);
    if (index >= 0) this.queue.splice(index, 1);
    this.settle(task, error);
  }

  private settle(task: Task, error?: Error, result?: unknown) {
    clearTimeout(task.timer);
    if (task.started) this.totalMs += performance.now() - task.started;
    if (error) { this.failed++; task.reject(error); } else { this.done++; task.resolve(result); }
  }

  private async runInline(task: Task) {
    task.started = performance.now();
    try {
      this.inline ??= import(/* @vite-ignore */ pathToFileURL(resolve(this.root, `src/workers/${this.name}.ts`)).href).then(module => module.default as H);
      const handlers = await this.inline;
      const handler = handlers[task.task];
      if (typeof handler !== 'function') throw new Error(`Worker "${this.name}" has no task "${task.task}".`);
      this.settle(task, undefined, structuredClone(await handler(structuredClone(task.payload) as never)));
    } catch (error) {
      this.settle(task, error instanceof Error ? error : new Error(String(error)));
    }
  }
}

/** One pool per worker module; call it at module level (e.g. in a feature or simulation file). */
export function workerPool<H extends WorkerHandlers>(name: string, options?: PoolOptions): WorkerPool<H> {
  const pool = new WorkerPool<H>(name, options);
  registry.pools.add(pool as unknown as WorkerPool<WorkerHandlers>);
  return pool;
}

/** Called when new server code finished loading: pools of older code are shut down. */
export function closeStalePools() {
  for (const pool of [...registry.pools]) if (pool.generation < generation) pool.close();
}

export function poolStats(): PoolStats[] {
  return [...registry.pools].map(pool => pool.stats());
}
