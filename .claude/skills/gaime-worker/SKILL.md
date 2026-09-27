---
name: gaime-worker
description: Move heavy server computation (pathfinding, map/level generation, AI planning, big searches, analytics) off the game loop into a gaime worker pool with ctx.job. Use when a feature would take more than a few milliseconds per tick or the load test shows the tick exceeding its budget.
---

# Heavy computation in workers

The simulation loop is single-threaded: ~33 ms per tick for everything. Anything that may take longer runs in a worker thread and its result is applied on a later tick.

## 1. The worker module — `games/<game>/src/workers/<name>.ts`

```ts
import { defineWorker } from '@gaime/core/worker';
import { RULES } from '../shared/rules';          // shared code is fine

export default defineWorker({
  flowField(input: { width: number; height: number; walls: number[]; target: number }) {
    // pure computation: data in → data out
    return { directions: new Array<number>(input.width * input.height).fill(0) };
  },
});
```

- Payload and result are structured-cloned: plain data only (no functions, class instances, world references).
- Stateless: a worker may be replaced at any time (timeout, hot reload). Cache nothing that matters.
- `name` = file name (lowercase, dashes).

## 2. The pool — e.g. `games/<game>/src/server/pathing.ts`

```ts
import { workerPool } from '@gaime/core/server';
export const pathing = workerPool<typeof import('../workers/pathing').default>('pathing', { size: 2, timeout: 3000 });
```

Create the pool at module level, once. Hot reload closes the old pool and creates a new one automatically.

## 3. Use it from the simulation with `ctx.job`

```ts
if (!world.flow.requested) {
  world.flow.requested = true;                         // the request lives in the world: survives HMR
  ctx.job(pathing.run('flowField', input), (world, result) => {
    world.flow.directions = result.directions;         // applied at the start of a tick, inside the simulation
    world.flow.requested = false;
  }, world => { world.flow.requested = false; });     // failure/timeout: allow a retry
}
```

- `ctx.job` results are dropped on hot reload — keep the "requested" flag in the world so the request is re-issued.
- Never block waiting for a job; keep playing with the previous result.
- Throttle: request again only when the inputs changed meaningfully or every N seconds (`every()` from the kit).

## 4. Verify

- Tests: without Vite, pools run tasks inline on the main thread (same results) — test the worker function directly or through `pool.run` with `{ root }` pointing at the game (see `packages/core/tests/workers.test.ts`).
- Dev: `/gaime/stats` → `workers` (size, busy, queued, done, failed, avgMs); F3 in the game shows it too.
- Production build: `npm run build -w games/<game>` must produce `dist/server/workers/<name>.mjs`.
- Load: `npm run load -- <game> --bots 40` — tick max should stay well under 33 ms.

## Pitfalls

- Passing the whole world to the worker every tick: cloning costs more than it saves. Send only what the computation needs.
- Forgetting the failure callback leaves `requested = true` forever.
- Workers cannot call `ctx`, touch the world, or emit events — only return data.

## Reference

`docs/SERVER.md#heavy-processing-workers`, `docs/reference/CONFIG.md`.
