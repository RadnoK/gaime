# Network protocol

WebSocket via Colyseus (MessagePack). Protocol version: `PROTOCOL_VERSION = 3` (`packages/core/src/shared/protocol.ts`), sent in `welcome`. Version 3 added batched client events (`events`); older clients keep working with one `event` message per event.

## Messages

| Direction | Type | Payload | Notes |
| --- | --- | --- | --- |
| C→S | `hello` | — | ask for a full snapshot (after a reconnect / a patch that did not fit) |
| C→S | `input` | game input | continuous; `GameClient.input()` sends changes at most once per server tick (at most ~30/s; `tickRate` from `welcome`) and repeats the state every 150 ms; the server keeps the last input for 400 ms; validated by `parseInput` |
| C→S | `command` | `{ type, ... }` | a discrete action → a module's `commands[type]` if one registered it, else `game.command`; types starting with `$` are engine commands (`$chat`, `$pause`, `$resume`) |
| C→S | `request` | `{ id, name, payload }` | RPC → `game.requests[name]`, answered with `response` |
| S→C | `welcome` | `{ id, game, version, protocol, revision, host, tickRate, room, world }` | full world projection + your player id; `tickRate` paces the client's input; `room` = `{ id, code? }` (the invite code of a private match) |
| S→C | `patch` | `{ base, revision, values?, removed?, entities?, streams? }` | difference against `base`; a wrong `base` makes the client send `hello` |
| S→C | `response` | `{ id, ok, result?, error? }` | |
| S→C | `events` | `[[name, data], …]` | protocol 3+ clients: every client event of one server tick in one message, in order — `ctx.emit()` and bus events listed in `network.events`; never stored in the world (sounds, screen shake) |
| S→C | `event` | `{ name, data }` | the same events, one message each, for clients that did not join with `protocol ≥ 3` |
| S→C | `notice` | text | private answer / toast |
| S→C | `removed` | — | you were removed from the game; close code 4102 follows |

## Joining

`GameClient` asks for a room and a seat in one request:

1. `POST /gaime/room` with `{ ticket, name, protocol?, ephemeral?, room?, code?, create? }` → `{ roomId, code?, mode, size?, reservation }`. Shared games: the one room. Matches ([ROOMS.md](ROOMS.md#matchmaking)): back into `room` if it takes this ticket, else the private match `code`, else a new private match (`create: 'private'`), else public matchmaking. Errors: `400` bad ticket, `403` full / locked / no private matches, `404` unknown code, `503` + `Retry-After` while the game (re)starts.
2. Colyseus `consumeSeatReservation(reservation)` connects to the room — to `reservation.publicAddress` when the room runs in another process ([ROOMS.md](ROOMS.md#scaling-out-with-redis)). The seat was reserved with the join options below.

Tools and older clients use the two-step form:

1. `GET /gaime/room` → `{ roomId, mode }` (shared), or `{ roomId, code?, mode: 'matches', size }` of an open room (`?code=ABCDE`: that private match; `?create=private`: a new one). No seat is held: the join can fail when the room fills up in between — ask again.
2. Colyseus `joinById(roomId, options)` with `{ ticket, name, protocol?, ephemeral? }`:
   - `ticket` — the browser identity (random, kept in localStorage per game and `?player=` slot); `onAuth` maps it to a player id. Never sent to other clients.
   - `name` — the lobby nickname (trimmed, ≤ 24 characters, made unique: a taken name becomes `Name 2`, `Name 3`…; a returning player keeps their name if the requested one is taken, with a notice).
   - `protocol` — the client's protocol version (`GameClient` sends `PROTOCOL_VERSION`). `3` or more: the client receives batched `events` messages; absent or lower: one `event` message per event. The option name is exported as `JOIN_PROTOCOL`.
   - `ephemeral: true` — a throwaway player (load-test bots): marked `data['gaime-ephemeral']` and removed from the world when it leaves.
3. The server answers with `welcome`, then patches.

Reconnects use Colyseus' reconnection token within `reconnectSeconds`; after that the client joins again with the same ticket and gets the same character (with `keepPlayers: true`) — in matches mode through `POST /gaime/room` with the remembered `room`. Server-controlled bots never connect — they are players flagged `data['gaime-bot']` and driven by `GameDefinition.bot`.

Close codes: **4102** removed, **4103** the game was opened in another tab. (4000–4010 belong to Colyseus.)

HTTP: `GET /health` → `{ ok, game, version, error, disabled?, uptime, rooms }` (the version of the code that is **loaded** — also after HMR — modules switched off after an error, rooms in this process), `GET`/`POST /gaime/room` (above), `GET /gaime/stats` → rooms and clients of this process, tick rate, tick/publish costs, patch sizes, event-loop delay, dropped simulated time, engine counters, the most expensive systems/handlers/commands (`parts`), memory, workers (reading it resets nothing). `/gaime/admin/*` — operator API (token; `?room=<id|code>` picks a room, `rooms` lists them).

## Client events

Two sources feed the same channel:

- `ctx.emit(name, data, playerId?)` — an ad-hoc event to everyone or one player;
- **forwarded bus events** — every event named in `network.events` is, besides being dispatched to `on` handlers on the server, queued for every client with its payload:

  ```ts
  network: { events: ['pickup.collected'] },        // games/blank
  // client
  net.onEvent('pickup.collected', ({ playerId }) => { … });           // or net.on('event', (name, data) => …) for all
  ```

The room collects the events of one tick and sends each client **one message** at the end of the tick: `events` with `[[name, data], …]` in order (events to everyone first, then that player's own). At most **256 events per client per tick** are sent; the rest are dropped and counted in `/gaime/stats` → `engine.droppedEvents` — a flood of sounds helps nobody, and an unbounded list would hurt everyone's bandwidth. Events are never stored or replayed: a client that joins or reconnects later does not see them. Anything that must be seen later belongs in the world.

## Delta sync

The server never sends the authoritative object. On publish it makes a **projection** (`projectWorld`): a copy without `hidden` keys, with fields rounded according to `precision` (by default `x,y,z,vx,vy,vz,angle,aim,yaw` to 0.01, `time` to 0.001). The server remembers the last projection sent to each client; a patch is the difference between it and the current one:

- `entities` — `Record<id, object>` dictionaries listed in `network.entities`, diffed per entity and per field (`upsert` only changed fields, `remove`). A disappearing optional field replaces the whole entity.
- `streams` — arrays of immutable objects with an `id` (`feed`, effects): `add` / `remove`.
- `values` — everything else as whole values when they change. **New world fields work without configuration** — just less efficiently until you add them to `entities`/`streams`.
- `shared` — keys replaced wholesale and never mutated (e.g. `catalog`): compared by reference, left out of the checkpoint, rebuilt in `prepare`.

The engine's timer queue (`world.schedule`) is always hidden — it never leaves the server (operators still see it with `gaime world`). Clients sharing a base get the same bytes (one diff and one encoding per group). With a per-player `view` (hidden information, [SERVER.md](SERVER.md#per-player-views)) each client's projection is passed through `view(projection, playerId)` and diffed separately — more CPU per publish, same wire format. A client whose send buffer exceeds 64 KB is skipped until it drains (then it gets a patch from its own base).

```ts
network: {
  entities: ['players', 'enemies', 'projectiles'],
  streams: ['feed', 'effects'],
  shared: ['catalog'],
  hidden: ['spawns', 'rngState'],
  precision: { hp: 1 },           // hp as integers on the wire
},
publishEvery: 2,                  // 30 Hz tick / 2 = 15 patches per second
```

## Client

```ts
const net = new GameClient<World, Input, Command, Events>({ game: 'my-game' });
net.on('world', (world, previous) => render(world));
net.onEvent('enemy.died', ({ x, z }) => boom(x, z));                     // a forwarded bus event, typed from Events
net.on('event', (name, data) => { if (name === 'sound') play(data); });   // every event: ctx.emit and forwarded ones
net.on('status', (state, text) => hud.status(state, text));
await net.join('Ola');
net.input({ mx, mz, ax, az, fire });
net.command({ type: 'cast', slot: 0, x, z });
net.chat('/help');
const top = await net.request<Row[]>('scoreboard');
net.stats; // { ping, patchesPerSecond, bytesPerSecond, inputsPerSecond, resyncs }
```

Interpolation: `ServerClock.sync(world.time)` on every world and `clock.now()` to render just far enough in the past (one patch interval plus the measured jitter, ~80 ms at 15 Hz); `Interpolator.push(id, world.time, {x, z, angle})` / `.sample(id, t)`. Predict your own character locally with the same movement function as the server (see `games/starter/src/shared/rules.ts` and `scene.ts`).

## Chat

`$chat` with text (≤ 200 characters, limits: 1 message per 350 ms and 8 per 10 s). Messages land in `world.feed` (`{ id, time, text, from?, kind? }`, last 40). Built-in commands: `/help`, `/w <nick> <text>` (private), `/me`, `/nick`, `/who`, `/kick` (host), `/pause`, `/resume` (host). Your own:

```ts
chat: {
  commands: { roll: { description: 'roll a die', run: (world, id, args, ctx) => `🎲 ${1 + Math.floor(ctx.random() * 6)}` } },
  filter: (text, player) => text.replace(/darn/gi, '***'),   // null = drop the message
},
```

## Latency budget

What a player feels is more than the distance to the server. For another player's movement, roughly:

| Part | Default (30 Hz tick, `publishEvery: 2`) | Fast (`tickRate: 60, publishEvery: 1`) |
| --- | --- | --- |
| Network round trip (distance + routing; Poland → Frankfurt ~20 ms, Europe → US East ~90–110 ms) | RTT | RTT |
| Input waits for the next tick (the client sends once per tick) | ~17 ms avg | ~8 ms |
| The result waits for the next publish | ~33 ms avg | ~8 ms |
| Interpolation buffer (`clock.now()`: one patch interval + jitter) | ~80 ms | ~30–45 ms |
| Render frame | ~8–16 ms | ~8–16 ms |
| **Total without the round trip** | **~140 ms** | **~60 ms** |

Your own character feels instant only with client-side prediction (the shared movement function, see above); without it every key press waits a full round trip plus a tick.

The fast settings are a game's choice in `defineGame`: they double the simulation cost and quadruple the patches per second (bandwidth, publish CPU). Use them for action games with few to tens of players; turn-based and slow games keep the defaults. Check with `npm run load` that `tickMsMax` stays under `1000 / tickRate` (16.7 ms at 60 Hz).

Beyond the settings:

- **Region.** One game = one room on one server: pick the region closest to most players. Nothing hides a 100 ms round trip to another continent.
- **Packet loss.** WebSocket runs over TCP, so a lost packet holds back the ones behind it for a retransmit (a visible hitch). Interpolation absorbs short ones; there is no unreliable (UDP) channel.
- **Proxies.** Point the game's domain straight at the server (on Cloudflare: "DNS only", not proxied); the local gateway and Caddy/Traefik add well under 1 ms.
- **CPU.** A shared vCPU with noisy neighbours stretches ticks; watch `eventLoopDelayMs` and `tickMs.max` in `/gaime/stats` and move to a dedicated vCPU when p99 grows.
- **`GAIME_LATENCY_MS`** simulates delay for testing only — keep it empty in production.

## Latency and load testing

| Tool | What it does |
| --- | --- |
| `?lag=150&jitter=40&loss=5` in the game URL | bad-network simulation in the browser: round-trip delay (ms), ± spread, % of dropped inputs; message order is preserved like on TCP |
| `GAIME_LATENCY_MS=120 npm run dev` | delay on the server side (for every client, `COLYSEUS_LATENCY`) |
| F3 in any game using `GameUi` | ping, patches/s, KB/s, inputs/s, resyncs + live server and worker costs |
| `npm run load -- --bots 50 --seconds 30` | real WebSocket bots: join time, RTT p50/p95/p99/max, messages and KB per bot, maximum tick/publish/patch, event-loop delay; warns when the tick does not fit its budget (`1000 / tickRate` ms) |
| `gaime load --input '{"mx":"$rand","fire":"$bool"}' --rate 30 --chat 0.5` | your own input template (`$rand`, `$rand*25`, `$bool`, `$int(a,b)`, `$pick(a|b)`), rate, chat |
| `npm run smoke` | correctness: patches, chat, reconnect, tab takeover, (`--hmr`) backend hot reload |

Bots join with the `ephemeral` option — their characters disappear after the test and do not litter the save.

When the tick cannot keep up: find the expensive part in `/gaime/stats` → `parts` (systems, handlers and commands by module, in ms per second), make it cheaper (spatial indexes; AI in a system with `every` instead of every tick), move heavy work to workers, raise `publishEvery`, add large dictionaries to `entities`, hide server-only state with `hidden`, round more fields. The server's fixed-step clock catches up at most 3 ticks after a slow one; beyond that the game slows down briefly and `droppedMs` in `/gaime/stats` grows.
