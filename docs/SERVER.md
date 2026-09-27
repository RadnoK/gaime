# Game server

## `defineGame`

```ts
defineGame<World, Input>({
  name,                      // stable game key
  maxPlayers, keepPlayers,   // online limit, whether a character stays after leaving
  tickRate: 30, publishEvery: 2, reconnectSeconds: 30, inputLeaseMs: 400, maxMessagesPerSecond: 90,
  network,                   // docs/PROTOCOL.md
  createWorld, migrate, prepare,
  createPlayer, onPlayerOnline, onPlayerRemoved,
  parseInput, step, command,
  requests, chat, admin, routes,
});
```

`GameContext` (`ctx`) in every hook: `world`, `log(text)`, `notify(playerId, text)`, `emit(name, data, playerId?)`, `nextId()`, `random()`, `isHost(id)`, `findPlayer(nick)`, `removePlayer(id)`, `save()`, `job(promise, apply, fail?)`.

## Heavy processing: workers

The simulation loop is single-threaded and has ~33 ms per tick. Work that may take longer (grid pathfinding, map generation, AI simulations, analysis) goes to a thread pool:

```ts
// src/workers/pathing.ts — a pure function from data to data
import { defineWorker } from '@gaime/core/worker';
export default defineWorker({
  flowField(input: { width: number; height: number; walls: number[]; target: number }) {
    // … BFS over the whole grid …
    return { directions };
  },
});
```

```ts
// src/server/pathing.ts
import { workerPool } from '@gaime/core/server';
export const pathing = workerPool<typeof import('../workers/pathing').default>('pathing', { size: 2, timeout: 3000 });

// in step / a command:
if (!world.flowRequested) {
  world.flowRequested = true;                                  // the request lives in the world (survives HMR)
  ctx.job(pathing.run('flowField', input), (world, result) => {  // applied at the start of a tick
    world.flow = result.directions; world.flowRequested = false;
  }, world => { world.flowRequested = false; });
}
```

- **Dev (Vite):** the worker loads TypeScript through the dev server — aliases, imports from `shared`, hot reload (editing a worker replaces the pool).
- **Production:** `vite build` bundles `src/workers/*.ts` into `dist/server/workers/*.mjs`.
- **Tests:** without Vite the tasks run on the same thread (same results).
- Payloads and results are copied (structured clone) — data only. A worker keeps no state between tasks. A timeout replaces the thread. `ctx.job` is dropped on hot reload — that is why the request flag lives in the world.
- Pool statistics: `/gaime/stats` → `workers` (size, busy, queued, done, failed, average time).

Example in the game: `games/starter/src/workers/tactics.ts` + the `/report` chat command.

Horizontal scaling (several Colyseus processes + Redis) is not needed for one shared arena; when a game gets many independent rooms, Redis presence/driver can be added in `createGameServer`.

## RPC and events

```ts
requests: {
  scoreboard: world => Object.values(world.players).map(p => ({ name: p.name, kills: p.kills })),
  async lookup(world, playerId, payload) { return await fetchSomething(payload); },   // may be async
},
```

Client: `await net.request('scoreboard')`. A thrown error → a rejected promise with the message. Events: `ctx.emit('sound', { kind: 'boom' })` (everyone) or with a `playerId` (one player) → `net.on('event', …)`.

## Operator: `gaime` against a running game

Inside the game directory (locally) or in the container (`docker compose exec game node /app/packages/host/bin/gaime.mjs …`):

```sh
gaime players                  # who is here, who is the host
gaime say "Restart at 8 pm"    # announcement in the feed
gaime kick Ola
gaime world players            # world dump / a single field (JSON)
gaime game pause | resume | save
gaime admin                    # the game's commands
gaime admin wave 5             # commands from GameDefinition.admin
```

Token: `GAIME_ADMIN_TOKEN` or the generated file `<data>/admin-token` (the CLI finds it by itself). The nginx gateway blocks `/gaime/admin/` from outside.

```ts
admin: {
  wave: { description: 'wave <n> — start a wave', run: (world, [n], ctx) => { …; return { wave: world.wave }; } },
},
```

## Metrics

`/gaime/stats` (10 s window): `tickMs`, `publishMs`, `patchBytes` (avg/max), `eventLoopDelayMs` (p50/p99/max), `clients`, `memoryMb`, `workers`. `gaime load` collects the same numbers.

## Saves

- `<data>/checkpoint.json` — `{ format, game, savedAt, version, world, identities }`. Under the supervisor `<data>` = `.gaime/<game>/data` or `GAIME_DATA_DIR`.
- Snapshots before every deploy: `.gaime/<game>/snapshots/` (last 40). Hourly backups on a VPS: `/srv/gaime/<game>/backups/`.
- Schema change: bump `SCHEMA`, rework old fields in `migrate(world)` (`if (world.schema === 1) {...; world.schema = 2}`). New fields need no migration. To deliberately start a fresh session: stop the game and move `checkpoint.json` away.
