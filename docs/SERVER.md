# Game server

The server side of a game is a **definition**: plain functions over a plain-JSON world. The engine (`@gaime/core/server`) runs them inside a Colyseus room and handles connections, identities, the tick loop, network sync, persistence, hot reload, chat, bots, workers and the admin API. Every option is listed in [reference/CONFIG.md](reference/CONFIG.md); this guide explains how they fit together.

## Files of a game

```text
src/shared/types.ts        World, Player, entities, Input, Command, module Kinds (+ Sim)
src/shared/rules.ts        constants and pure rules shared with the client (movement for prediction)
src/server/simulation.ts   createWorld, createPlayer, prepareWorld, step, command, bot brain
src/server/registry.ts     module registry (docs/MODULES.md)
src/server/game.ts         defineGame({...}) — wires it all together
src/server/index.ts        export const server = createGameServer(game)
src/workers/*.ts           optional worker pools
```

`simulation.ts` usually takes the registry as a parameter (`step(world, registry, inputs, dt, ctx)`) and `game.ts` binds it — that keeps the logic testable with any registry.

## `defineGame`

```ts
import { defineGame } from '@gaime/core/server';

export const game = defineGame<World, Input>({
  name: 'hive',                                  // stable key: room, checkpoint, browser storage — never rename
  maxPlayers: 16, keepPlayers: true,
  tickRate: 30, publishEvery: 2,
  network: { entities: ['players', 'wasps'], streams: ['feed', 'effects'], shared: ['catalog'], hidden: ['timers'] },

  createWorld,                                   // a fresh world (also the source of defaults for old saves)
  migrate: world => world,                       // upgrade old saves (see Persistence)
  prepare: world => prepareWorld(world, registry),
  createPlayer,
  onPlayerOnline(world, player, online, ctx) { /* joined / left */ },
  onPlayerRemoved(world, player, ctx) { /* about to be deleted */ },

  parseInput,                                    // validate raw client input
  step: (world, inputs, dt, ctx) => step(world, registry, inputs, dt, ctx),
  command: (world, id, c, ctx) => command(world, registry, id, c as Command, ctx),
  bot: botInput,
  view: undefined,                               // optional per-player filtering

  requests: { scoreboard: world => topTen(world) },
  chat: { commands: { roll: { description: 'roll a die', run: () => '🎲 4' } } },
  admin: { spawn: { description: 'spawn <kind>', run: (world, [kind], ctx) => spawn(world, kind, ctx) } },
  routes: app => app.get('/api/hello', (_req, res) => { res.json({ ok: true }); }),
});
```

## World and players

The world extends `BaseWorld<Player>` from `@gaime/core`:

| Field | Meaning |
| --- | --- |
| `schema` | your save schema number (`SCHEMA` constant, see migrations) |
| `version` | the code version that last ran (set by the engine) |
| `time` | simulation time in seconds; stops while paused |
| `pause` | `null` or `{ reason: 'host' \| 'error', message? }` |
| `hostId` | the game host: the first online human; moves on when they leave |
| `players` | `Record<id, Player>` |
| `feed` | the last 40 feed/chat items (`pushFeed`, `ctx.log`) |
| `seq` | counter behind `ctx.nextId()` |

Start from `baseWorld(SCHEMA)` and add your fields. Players extend `BasePlayer` (`id`, `name`, `online`, `data`). The world must be **plain JSON** — no `Map`, `Set`, classes, functions or `Date` — because it is saved, diffed and cloned. Per-entity extension state goes into `data` records with prefixed keys.

## The tick

At `tickRate` (default 30 Hz) the room:

1. applies finished `ctx.job` results;
2. collects each player's latest input (inputs older than `inputLeaseMs` are dropped, so a frozen client stops moving) and asks `bot()` for every bot;
3. unless paused: `world.time += dt`, then `step(world, inputs, dt, ctx)`;
4. every `publishEvery` ticks sends patches ([PROTOCOL.md](PROTOCOL.md));
5. about every 2 s writes a checkpoint.

`step` gets `inputs: Record<playerId, Input>` — only players who sent something recently. Everything that changes over time happens here: movement, AI, timers, collisions, spawns, round logic. Use `dt` and `world.time`, never wall-clock time; use `ctx.random()`, never `Math.random()` (tests pass a seeded one). Reusable pieces — collision, projectiles, cooldowns, rounds, turns — are in the kit ([KIT.md](KIT.md)).

## Talking to clients

| Mechanism | Direction | For | Server side |
| --- | --- | --- | --- |
| **input** | client → server, continuous | held state: movement, aim, trigger | `parseInput` + `step(inputs)` |
| **command** | client → server, discrete | actions: cast, buy, ready, fire | `command(world, playerId, command, ctx)`; return a string = private reply |
| **request** | client → server → client | queries: leaderboards, previews, validation | `requests[name](world, playerId, payload, ctx)`; may be async |
| **world** | server → clients, continuous | all shared state | just mutate the world |
| **event** | server → client(s), one-off | sounds, shake, "you got hit" | `ctx.emit(name, data, playerId?)` |
| **notice** | server → one client | private messages, refusals | `ctx.notify(id, text)` or return a string from a command |
| **feed** | server → everyone, stored | announcements | `ctx.log(text)` |

Validate everything from clients in `parseInput` / `command`: clamp numbers, check types, check that the player may do it. A command that throws only produces an error notice for its author; the game keeps running.

## `GameContext`

Every hook gets `ctx`:

| Member | Use |
| --- | --- |
| `world` | the authoritative world |
| `log(text)` | feed message for everyone (saved) |
| `notify(playerId, text)` | private toast |
| `emit(name, data?, playerId?)` | one-off event to everyone or one player (not saved) |
| `nextId()` | unique, persisted number for entity ids |
| `random()` | randomness (seedable in tests) |
| `isHost(id)` | whether the player is the game host |
| `findPlayer(nameOrId)` | case-insensitive lookup (exact, then unique prefix) |
| `removePlayer(id)` | delete a player and close their connections |
| `save()` | ask for a checkpoint soon |
| `job(promise, apply, fail?)` | apply async results on a later tick (see Workers) |
| `addBot(name?)`, `isBot(id)` | server-controlled players (see Bots) |
| `command(playerId, command)` | run your `command` handler as that player (bots, scripted events) and get its reply; never throws — an exception is logged and comes back as the reply `Error in the code of command "<type>": <message>`, without pausing the game |

## Players and sessions

- **Identity**: the browser keeps a random ticket in localStorage (per `?player=` slot); the server maps it to a player id. A reload, a server restart or a deploy brings back the same character. Tickets are never sent to other clients.
- **Joining**: a new identity → `createPlayer(world, id, name, ctx)` then `onPlayerOnline(world, player, true, ctx)`. A returning one → `onPlayerOnline(..., true)` only.
- **Leaving**: when the connection drops the player goes offline at once (`onPlayerOnline(..., false)`); the connection may resume within `reconnectSeconds` (30 s) and comes back online. With `keepPlayers: false` a player who leaves for good (or does not reconnect in time) is removed (`onPlayerRemoved`), freeing the seat; with `true` the offline character stays in the world.
- **Takeover**: the same identity in another tab takes the character; the old tab is closed with code 4103.
- **Limits**: `maxPlayers` counts online players (bots included); a full game refuses joins with a clear message.
- **Host**: the first online human; can `/pause`, `/resume`, `/kick`, `/bot` and whatever your commands allow via `ctx.isHost(id)`.
- **Names**: from the lobby, unique (case-insensitive), changeable with `/nick`. A new player whose name is taken becomes `Name 2`, `Name 3`…; a returning player who asks for a name someone else uses keeps their old one and gets a notice. The client follows renames, so a later rejoin sends the current name.

## Bots

Give the game a brain and the host can add bots with `/bot [name]` (and `/bot remove`):

```ts
bot(world, botId, ctx) {
  const me = world.players[botId];
  const target = nearest(me, Object.values(world.wasps), 15);
  if (target && cooldown.ready(me.cooldowns, 'sting', world.time)) ctx.command(botId, { type: 'sting', id: target.id });
  return { mx: target ? Math.sign(target.x - me.x) : 0, mz: target ? Math.sign(target.z - me.z) : 0 };
},
```

A bot is created with your `createPlayer`, flagged `data['gaime-bot'] = true`, always online, and driven by the same `Input` and commands as humans — no special cases in the rules. Add them from code with `ctx.addBot(name)`; a taken name gets a number (`Bot 2`) like a human's. Details and tactics: the `gaime-bot` skill.

## Per-player views

By default everyone receives the same projection of the world. For hidden information (cards in hand, fog of war, secret roles) add `view`:

```ts
view: (world, playerId) => ({
  ...world,
  hands: { [playerId]: world.hands[playerId] ?? [] },
  wasps: Object.fromEntries(Object.entries(world.wasps).filter(([, w]) => visibleTo(world, playerId, w))),
}),
```

`view` receives the network projection (already a copy with `hidden` keys removed) and must return a new object for every key it changes — never mutate. Each client then gets its own diff, so the publish cost grows with the number of clients. Server-only fields that nobody should see belong in `network.hidden` instead.

## Chat

Built in: `/help`, `/w <nick> <text>`, `/me`, `/nick`, `/who`, `/kick` (host), `/pause`, `/resume` (host), `/bot` (host, when `bot` exists). Messages are rate-limited (1 per 350 ms, 8 per 10 s), max 200 characters, and land in `world.feed` with `kind: 'chat'`.

```ts
chat: {
  commands: {
    roll: { description: 'roll a die', usage: '[sides]', run: (world, id, args, ctx) => { ctx.log(`🎲 ${1 + Math.floor(ctx.random() * (Number(args) || 6))}`); } },
    reset: { description: 'reset the scores', host: true, run: world => { for (const p of Object.values(world.players)) p.score = 0; } },
  },
  filter: (text, player) => text.replace(/darn/gi, '***'),     // return null to drop the message
},
```

Returning a string from `run` answers the author privately.

## Requests (RPC) and events

```ts
requests: {
  scoreboard: world => Object.values(world.players).map(p => ({ name: p.name, score: p.score })),
  async preview(world, playerId, payload) { return await pathing.run('route', payload as RouteInput); },
},
```

Client: `await net.request('scoreboard')`. A thrown error rejects the client's promise with the message; a request that takes longer than the client's timeout (5 s) rejects there. Events: `ctx.emit('sound', { kind: 'boom' })` → `net.on('event', (name, data) => …)`.

## Heavy processing: workers

The loop is single-threaded and has ~33 ms per tick for everyone. Work that may take longer (grid pathfinding, map generation, AI planning, analysis) goes to a thread pool:

```ts
// src/workers/pathing.ts — pure functions from data to data
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
  world.flowRequested = true;                                    // the request lives in the world (survives HMR)
  ctx.job(pathing.run('flowField', input), (world, result) => {  // applied at the start of a later tick
    world.flow = result.directions; world.flowRequested = false;
  }, world => { world.flowRequested = false; });
}
```

- **Dev (Vite)**: workers load TypeScript through the dev server — aliases, imports from `shared`, hot reload (editing a worker replaces the pool).
- **Production**: `vite build` bundles `src/workers/*.ts` into `dist/server/workers/*.mjs`.
- **Tests**: without Vite the tasks run on the same thread with the same results.
- Payloads and results are structured-cloned — data only. Workers keep no state between tasks. A timeout replaces the thread. Pending jobs are dropped on hot reload — keep the "requested" flag in the world.
- Pool statistics: `/gaime/stats` → `workers` (size, busy, queued, done, failed, average time).

Example: `games/starter/src/workers/tactics.ts` + the `/report` chat command. Step by step: the `gaime-worker` skill.

Horizontal scaling (several processes + Redis) is not needed for one shared arena per game; if a game ever needs many independent rooms, Colyseus' Redis presence/driver can be added in `createGameServer`.

## Errors

- An exception in `step`, a hook, `bot`, `prepare` or a job's `apply` → the game pauses with `world.pause = { reason: 'error', message }`, a ⚠ line in the feed, and `/health` reports the error. The next code load (save/push) resumes it; the host can also `/resume`.
- An exception in a `command` or `request` → an error notice / rejected promise for that player only; the game is not paused. A command run through `ctx.command` returns the error text as its reply instead of throwing.
- An exception while importing the server code (registry validation, syntax) → the old code keeps running locally; on the server the supervisor reverts the commit.

## Persistence

- `<data>/checkpoint.json` — `{ format, game, savedAt, version, world, identities }`, written atomically (temp file + rename) about every 2 s while time moves or something changed, before a hot reload and on shutdown. `<data>` is `GAIME_DATA_DIR`, under the supervisor `.gaime/<game>/data`.
- **Loading** a save or a hot-reload cache: `hydrate` fills fields missing in the saved world and players from `createWorld()` and a template `createPlayer()`, then `migrate(world)`, then `prepare(world, ctx)`. The template player is built on a scratch world with a sandboxed `ctx` (`log`, `notify`, `emit`, `save`, `job`, `removePlayer` do nothing; `addBot` throws), so it cannot touch the real world. `network.shared` keys are not saved — rebuild them in `prepare`.
- **New fields** need nothing: give them defaults in `createWorld` / `createPlayer`.
- **Changed fields**: bump `SCHEMA` and convert in `migrate`:

  ```ts
  migrate(world) {
    if (world.schema < 2) { for (const p of Object.values(world.players)) p.gold = (p as any).coins * 10; world.schema = 2; }
    return world;
  },
  ```

  Throwing from `migrate` refuses the save; it is kept untouched.
- **Unreadable saves** are never overwritten: the game runs "frozen" (pauses cannot be lifted) until the file is fixed or restored.
- Snapshots before every deploy: `.gaime/<game>/snapshots/` (last 40). Hourly backups on a VPS: `/srv/gaime/<game>/backups/`.
- A deliberately fresh start: stop the game and move `checkpoint.json` away.

## Operator commands

Inside the game directory (locally) or in the container (`docker compose exec game node /app/packages/host/bin/gaime.mjs …`):

```sh
gaime players                  # who is here, who is the host
gaime say "Restart at 8 pm"    # announcement in the feed
gaime kick Ola
gaime world players            # world dump / one field (JSON)
gaime game pause | resume | save
gaime admin                    # list the game's commands
gaime admin spawn wasp 5       # run one (GameDefinition.admin)
```

```ts
admin: {
  spawn: { description: 'spawn <kind> [count]', run: (world, [kind, count], ctx) => { /* … */ return { spawned: Number(count) || 1 }; } },
},
```

The token comes from `GAIME_ADMIN_TOKEN` or the generated `<data>/admin-token` (the CLI finds it). The nginx gateway blocks `/gaime/admin/` from outside. All commands: [reference/CLI.md](reference/CLI.md).

## HTTP

| Route | Returns |
| --- | --- |
| `GET /health` | `{ ok, game, version, error, uptime }` — the version of the code actually loaded and the last code error |
| `GET /gaime/room` | `{ roomId }` of the shared room |
| `GET /gaime/stats` | `tickMs`, `publishMs`, `patchBytes` (avg/max) over a 10 s window, `eventLoopDelayMs` (p50/p99/max, the worst of the last full 10 s window and the current one), `clients`, `tickRate`, `memoryMb`, `workers`. Reading does not reset anything, so the F3 overlay and `gaime load` can read it at the same time |
| `POST /gaime/admin/:action` | operator API (Bearer token) |
| `routes(app)` | your own Express routes — registered once per process, so changes need a restart |

## Testing

`testContext(world, { random, command })` gives a full `GameContext` without a room — see [TESTING.md](TESTING.md).
