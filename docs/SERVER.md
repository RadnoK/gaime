# Game server

The server side of a game is a **definition**: plain functions over a plain-JSON world, plus the behaviour (event handlers, modifiers, systems) that the game and its modules plug into the engine. The engine (`@gaime/core/server`) runs them inside a Colyseus room and handles connections, identities, the fixed-step clock, timers, the event bus, network sync, persistence, hot reload, chat, bots, workers and the admin API. Every option is listed in [reference/CONFIG.md](reference/CONFIG.md); this guide explains how they fit together.

**Read [SIMULATION.md](SIMULATION.md) first** — it is the model every rule and module is written against: one clock, events, modifiers, timers, systems, module commands, isolation.

## Files of a game

```text
src/shared/types.ts        World, Player, entities, Input, Command, Events, Modifiers, Sim, module Kinds
src/shared/rules.ts        constants and pure rules shared with the client (movement for prediction)
src/server/simulation.ts   createWorld, createPlayer, prepareWorld, makeSim, step, systems, command, bot brain
src/server/registry.ts     module registry (docs/MODULES.md)
src/server/game.ts         defineGame({...}) — wires it all together
src/server/index.ts        export const server = createGameServer(game)
src/workers/*.ts           optional worker pools
```

`simulation.ts` usually takes the registry as a parameter (`collect(sim, registry)`, `makeSim(registry, ctx, dt)`) and `game.ts` binds it — that keeps the logic testable with any registry. `games/blank/src/server/` is the smallest complete example.

## `defineGame`

```ts
import { defineGame } from '@gaime/core/server';

export const game = defineGame<World, Input, Sim, Events, Modifiers>({
  name: 'hive',                                  // stable key: room, checkpoint, browser storage — never rename
  maxPlayers: 16, keepPlayers: true,
  tickRate: 30, publishEvery: 2,
  network: { entities: ['players', 'wasps'], streams: ['feed', 'effects'], shared: ['catalog'], events: ['wasp.died'] },

  createWorld,                                   // a fresh world (also the source of defaults for old saves)
  migrate: world => world,                       // upgrade old saves (see Persistence)
  prepare: world => prepareWorld(world, registry),
  createPlayer,
  onPlayerOnline(world, player, online, ctx) { /* joined / left */ },
  onPlayerRemoved(world, player, ctx) { /* about to be deleted */ },

  features: registry,                            // modules' on / modify / systems / commands run in the engine
  sim: (ctx, dt) => makeSim(registry, ctx, dt),  // what handlers, systems and module commands receive

  parseInput,                                    // validate raw client input
  step,                                          // optional: per-tick input handling — step(world, inputs, dt, ctx, sim)
  systems: [                                     // the game's own per-tick / periodic work
    { id: 'wasps', run: sim => moveWasps(sim, registry) },
    { id: 'spawn', every: 2, run: spawnWasp },
  ],
  on: { 'wasp.died': ({ by }, sim) => { if (by) sim.world.players[by].score += 1; } },
  modify: { 'player.damage': (amount, { player }, sim) => amount },   // the game may adjust values too
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
| `time` | simulation time in seconds; advances by exactly `1 / tickRate` per tick, stops while paused — the one clock for every rule |
| `tick` | simulation steps since the world was created |
| `schedule` | engine timers (`ctx.after` / `ctx.every`): a heap of plain JSON, saved with the world, never sent to clients |
| `pause` | `null` or `{ reason: 'host' \| 'error', message? }` |
| `hostId` | the game host: the first online human; moves on when they leave |
| `players` | `Record<id, Player>` |
| `feed` | the last 40 feed/chat items (`pushFeed`, `ctx.log`) |
| `seq` | counter behind `ctx.nextId()` |

Start from `baseWorld(SCHEMA)` and add your fields. Players extend `BasePlayer` (`id`, `name`, `online`, `data`). The world must be **plain JSON** — no `Map`, `Set`, classes, functions or `Date` — because it is saved, diffed and cloned. Per-entity extension state goes into `data` records with prefixed keys.

## The tick

The tick pipeline — fixed step, due timers, `input` systems → `step` → `update` → `late`, events dispatched after the code that raised them — is described in [SIMULATION.md](SIMULATION.md), and how the room drives it in [ARCHITECTURE.md](ARCHITECTURE.md#one-tick). In short, at `tickRate` (default 30 Hz):

1. finished `ctx.job` results are applied;
2. unless paused: `world.time += 1 / tickRate`, `world.tick++`, due timers fire their events;
3. systems and `step` run in phase order; `step` gets `inputs: Record<playerId, Input>` — only players who sent something within `inputLeaseMs` (a frozen client stops moving) plus every bot's `bot()` input;
4. client events are flushed, every `publishEvery` ticks patches go out ([PROTOCOL.md](PROTOCOL.md)), about every 2 s a checkpoint is written.

Where the work goes:

| Work | Put it in |
| --- | --- |
| applying inputs (movement, aim) | `step` |
| per-tick rules (collisions, AI, projectiles) | a system (`systems: [{ id, run }]`) |
| periodic work (spawners, regeneration, AI thinking) | a system with `every: seconds` |
| something once, later (a fuse, a respawn, an expiry) | a timer: `ctx.after(seconds, event, data, { key })` |
| reactions across modules (kill → reward) | an event (`ctx.trigger`) + `on` handlers |
| numbers several modules adjust (damage, points, price) | `ctx.modify(name, value, data)` + `modify` |

Use `dt` and `world.time`, never wall-clock time; use `ctx.random()`, never `Math.random()` (tests pass a seeded one). Reusable pieces — collision, projectiles, cooldowns, rounds, turns — are in the kit ([KIT.md](KIT.md)).

### Events, modifiers and the `Sim`

Declare the game's bus in `src/shared/types.ts` — `Events` (name → payload) and `Modifiers` (name → the data passed along) — and pass both to `defineGame<World, Input, Sim, Events, Modifiers>` and to the module type (`FeatureModule<Kinds, Sim, Events, Modifiers>`), so `ctx.trigger`, `on`, timers and `modify` are type-checked and a misspelled name is a compile error. Handlers, modifiers, systems and module commands receive the object built by `sim(ctx, dt)`: a `Sim` facade with the world and the helpers the game allows module code to use (`spawnPickup`, `hurtEnemy`, `trigger`, `after`, `modify`, `emit`, `isolate`…). Without `sim` they receive the `GameContext`; `step` gets it as its fifth argument. `games/blank/src/shared/types.ts` and `makeSim` in `games/blank/src/server/simulation.ts` show the pattern.

Besides the game's own events, every bus carries:

- **engine events** — `player.joined` `{ player, bot }`, `player.online` `{ player }`, `player.offline` `{ player }`, `player.removed` `{ player, name }` — so the game and modules can react to players without hooks;
- **module-private events** named `<module>:<event>` (`ola-bomb:fuse`) — a module can trigger, schedule and handle them without an entry in `Events` (their payload is untyped: validate it). Anything other modules may react to belongs in `Events`.

**Modifiers run on the server only.** A value the client predicts (movement speed, collision size) must be computable on both sides from world data — a shared function in `src/shared/rules.ts` reading, e.g., a status in `player.data` — or prediction and server disagree and the player rubber-bands.

## Talking to clients

| Mechanism | Direction | For | Server side |
| --- | --- | --- | --- |
| **input** | client → server, continuous | held state: movement, aim, trigger | `parseInput` + `step(inputs)` |
| **command** | client → server, discrete | actions: cast, buy, ready, fire | `command(world, playerId, command, ctx)`, or a module's `commands[type]`; return a string = private reply |
| **request** | client → server → client | queries: leaderboards, previews, validation | `requests[name](world, playerId, payload, ctx)`; may be async |
| **world** | server → clients, continuous | all shared state | just mutate the world |
| **event** | server → client(s), one-off | sounds, shake, "you got hit" | `ctx.emit(name, data, playerId?)`, or list bus events in `network.events` to forward them |
| **notice** | server → one client | private messages, refusals | `ctx.notify(id, text)` or return a string from a command |
| **feed** | server → everyone, stored | announcements | `ctx.log(text)` |

Validate everything from clients in `parseInput` / `command` / module `commands`: clamp numbers, check types, check that the player may do it. A command that throws only produces an error notice for its author; the game keeps running.

A command's `type` is routed to a module's `commands[type]` when a module registered it, otherwise to the game's `command`. Types starting with `$` belong to the engine.

## `GameContext`

Every hook gets `ctx` (in module code it is usually wrapped by your `Sim`):

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
| `command(playerId, command)` | run a command as that player (bots, scripted events) — routed to a module's `commands` or your `command` — and get its reply; never throws — an exception is logged and comes back as the reply `Error in the code of command "<type>": <message>`, without pausing the game |
| `trigger(event, data)` | put an event on the bus — one of the game's `Events`, an engine event, or a private `<module>:<event>`; `on` handlers run right after the current piece of code, same tick ([SIMULATION.md](SIMULATION.md#events)) |
| `modify(name, value, data?)` | pass a value through every `modify[name]` of the game and the modules, in order |
| `after(seconds, event, data?, { key? })` | fire `event` once after `seconds` of world time; returns the timer key |
| `every(seconds, event, data?, { key?, times? })` | fire `event` every `seconds` (first after `seconds`); the same key + event + interval keeps the running timer |
| `cancel(key, { prefix? })` | cancel a timer, or every timer whose key starts with `key`; returns how many |
| `timeLeft(key)` | seconds until that timer fires, or `undefined` |
| `timers(prefix?)` | number of live timers (with that key prefix) |
| `isolate(owner, run)` | run code owned by a module (a definition hook): an exception switches that module off instead of pausing the game; returns `undefined` when it failed or the module is off. Owner `'game'` pauses as usual |
| `disabled(owner)` | whether a module is switched off after an error (until the next code load) |

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

Client: `await net.request('scoreboard')`. A thrown error rejects the client's promise with the message; a request that takes longer than the client's timeout (5 s) rejects there. Events triggered by a request handler are dispatched when it returns.

Client events have two sources, and both arrive through `net.on('event', (name, data) => …)`, batched per tick:

- `ctx.emit('sound', { kind: 'boom' }, playerId?)` — an ad-hoc message to everyone or one player;
- bus events listed in `network.events` (`events: ['pickup.collected']`) — every `ctx.trigger` of that event also goes to every client with its payload. No extra code on the server: the event already exists for the game logic.

Neither is stored in the world — late joiners never see them. Use them for sounds and effects; state belongs in the world.

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

Two levels, depending on who owns the code that threw:

- **Module code** — a module's `on` handlers, `modify` functions and `systems`, and definition hooks the game runs through `ctx.isolate(owner, …)` / `sim.isolate` → **that module is switched off**: its behaviour stops, a ⚠ line in the feed names it, and `/health` lists it under `disabled` (`{ "<module>": "<message>" }`). The rest of the game keeps running; `ctx.disabled(owner)` tells the game (fall back to a default behaviour). The next code load switches it back on. A module's command that is switched off answers `"<type>" is switched off after an error in module <id>.`
- **Game code** — `step`, the game's own `systems` / `on` / `modify`, `bot`, `prepare`, `onPlayerOnline`, a job's `apply` → the game pauses with `world.pause = { reason: 'error', message }`, a ⚠ line in the feed, and `/health` reports the error (`ok: false`). The next code load (save/push) resumes it; the host can also `/resume`.
- **Commands and requests** (the game's and modules') → an error notice / rejected promise for that player only; nothing is paused or switched off. A command run through `ctx.command` returns the error text as its reply instead of throwing.
- **An event storm** — more than 50 000 events in one dispatch cycle, usually a handler triggering the event it handles — throws in the code that raised the last event: its module is switched off (or the game pauses, when it was game code). The queued events are dropped.
- **Import-time errors** (registry validation, invalid `on`/`systems`/`commands`, syntax) → the old code keeps running locally; on the server the supervisor reverts the commit.

Tests are strict by default: `testGame` throws module errors instead of switching modules off, so a broken module fails its test ([TESTING.md](TESTING.md)).

## Persistence

- `<data>/checkpoint.json` — `{ format, game, savedAt, version, world, identities }`, written atomically (temp file + rename) about every 2 s while time moves or something changed, before a hot reload and on shutdown. `<data>` is `GAIME_DATA_DIR`, under the supervisor `.gaime/<game>/data`.
- **Loading** a save or a hot-reload cache: `hydrate` fills fields missing in the saved world and players from `createWorld()` and a template `createPlayer()`, then `migrate(world)`, then `prepare(world, ctx)`. The template player is built by a scratch engine on a scratch world (its `ctx` effects are thrown away; `addBot` throws), so it cannot touch the real world. `network.shared` keys are not saved — rebuild them in `prepare`.
- **New fields** need nothing: give them defaults in `createWorld` / `createPlayer`. The engine's own fields (`tick`, `schedule`) are filled the same way for saves that predate them.
- **Timers are saved** with the world (`world.schedule`: event name, payload, time). Renaming an event or changing its payload affects timers already pending in live saves — keep handling the old form until they have fired, or cancel them in `migrate` (`cancelTimers(world.schedule, prefix)` from `@gaime/core`).
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
| `GET /health` | `{ ok, game, version, error, disabled?, uptime }` — the version of the code actually loaded, the last code error, and modules switched off after an error (only present when there are any) |
| `GET /gaime/room` | `{ roomId }` of the shared room |
| `GET /gaime/stats` | `tickMs`, `publishMs`, `patchBytes` (avg/max) over a 10 s window, `eventLoopDelayMs` (p50/p99/max, the worst of the last full 10 s window and the current one), `droppedMs` (simulated time the server could not keep up with), `engine` (event, timer and dropped-event counters), `parts` (the 15 most expensive systems, handlers and commands: `msPerSecond`, `callsPerSecond`, `maxMs`), `clients`, `tickRate`, `memoryMb`, `workers`. Reading does not reset anything, so the F3 overlay and `gaime load` can read it at the same time. Field by field: [reference/CONFIG.md](reference/CONFIG.md#http-endpoints) |
| `POST /gaime/admin/:action` | operator API (Bearer token) |
| `routes(app)` | your own Express routes — registered once per process, so changes need a restart |

## Testing

`testGame(game, { random: seeded(1) })` runs the whole game on the same engine the server uses — clock, timers, events, systems, modules, commands, bots — without a network: `t.join('Ada')`, `t.input(id, input)`, `t.run(seconds)`, `t.command(id, c)`, `t.triggeredOf('pickup.collected')`. `testContext(world, { random, command })` gives a bare `GameContext` for unit tests of single functions. See [TESTING.md](TESTING.md).
