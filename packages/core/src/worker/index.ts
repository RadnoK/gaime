/**
 * Heavy work off the simulation thread. A worker module lives in `src/workers/<name>.ts`:
 *
 *   import { defineWorker } from '@gaime/core/worker';
 *   export default defineWorker({
 *     async flowField(input: { size: number }) { ...; return field; },
 *   });
 *
 * and the server uses it through `workerPool<typeof import('../workers/<name>').default>('<name>')`.
 * Payloads and results are structured-cloned (plain data only, no functions or class instances).
 * Workers must be stateless between tasks: a hot reload or a timeout replaces them at any time.
 */
export type WorkerHandlers = Record<string, (payload: never) => unknown>;

export function defineWorker<H extends WorkerHandlers>(handlers: H): H {
  return handlers;
}
