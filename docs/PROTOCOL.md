# Network protocol

WebSocket via Colyseus (MessagePack). Protocol version: `PROTOCOL_VERSION = 2` (`packages/core/src/shared/protocol.ts`), sent in `welcome`.

## Messages

| Direction | Type | Payload | Notes |
| --- | --- | --- | --- |
| C→S | `hello` | — | ask for a full snapshot (after a reconnect / a patch that did not fit) |
| C→S | `input` | game input | continuous; `GameClient.input()` sends changes at most ~30/s and repeats the state every 150 ms; the server keeps the last input for 400 ms; validated by `parseInput` |
| C→S | `command` | `{ type, ... }` | a discrete action → `game.command`; types starting with `$` are engine commands (`$chat`, `$pause`, `$resume`) |
| C→S | `request` | `{ id, name, payload }` | RPC → `game.requests[name]`, answered with `response` |
| S→C | `welcome` | `{ id, game, version, protocol, revision, host, world }` | full world projection + your player id |
| S→C | `patch` | `{ base, revision, values?, removed?, entities?, streams? }` | difference against `base`; a wrong `base` makes the client send `hello` |
| S→C | `response` | `{ id, ok, result?, error? }` | |
| S→C | `event` | `{ name, data }` | `ctx.emit()`; never stored in the world (sounds, screen shake) |
| S→C | `notice` | text | private answer / toast |
| S→C | `removed` | — | you were removed from the game; close code 4102 follows |

Close codes: **4102** removed, **4103** the game was opened in another tab. (4000–4010 belong to Colyseus.)

HTTP: `GET /health` → `{ ok, game, version, error, uptime }` (the version of the code that is **loaded** — also after HMR), `GET /gaime/room` → `{ roomId }`, `GET /gaime/stats` → tick/publish costs, patch sizes, event-loop delay, memory, workers. `/gaime/admin/*` — operator API (token).

## Delta sync

The server never sends the authoritative object. On publish it makes a **projection** (`projectWorld`): a copy without `hidden` keys, with fields rounded according to `precision` (by default `x,y,z,vx,vy,vz,angle,aim,yaw` to 0.01, `time` to 0.001). The server remembers the last projection sent to each client; a patch is the difference between it and the current one:

- `entities` — `Record<id, object>` dictionaries listed in `network.entities`, diffed per entity and per field (`upsert` only changed fields, `remove`). A disappearing optional field replaces the whole entity.
- `streams` — arrays of immutable objects with an `id` (`feed`, effects): `add` / `remove`.
- `values` — everything else as whole values when they change. **New world fields work without configuration** — just less efficiently until you add them to `entities`/`streams`.
- `shared` — keys replaced wholesale and never mutated (e.g. `catalog`): compared by reference, left out of the checkpoint, rebuilt in `prepare`.

Clients sharing a base get the same bytes (one diff and one encoding per group). A client whose send buffer exceeds 64 KB is skipped until it drains (then it gets a patch from its own base).

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
const net = new GameClient<World, Input, Command>({ game: 'my-game' });
net.on('world', (world, previous) => render(world));
net.on('event', (name, data) => { if (name === 'sound') play(data); });
net.on('status', (state, text) => hud.status(state, text));
await net.join('Ola');
net.input({ mx, mz, ax, az, fire });
net.command({ type: 'cast', slot: 0, x, z });
net.chat('/help');
const top = await net.request<Row[]>('scoreboard');
net.stats; // { ping, patchesPerSecond, bytesPerSecond, inputsPerSecond, resyncs }
```

Interpolation: `ServerClock.sync(world.time)` on every world and `clock.now(0.1)` to render 100 ms in the past; `Interpolator.push(id, world.time, {x, z, angle})` / `.sample(id, t)`. Predict your own character locally with the same movement function as the server (see `games/starter/src/shared/rules.ts` and `scene.ts`).

## Chat

`$chat` with text (≤ 200 characters, limits: 1 message per 350 ms and 8 per 10 s). Messages land in `world.feed` (`{ id, time, text, from?, kind? }`, last 40). Built-in commands: `/help`, `/w <nick> <text>` (private), `/me`, `/nick`, `/who`, `/kick` (host), `/pause`, `/resume` (host). Your own:

```ts
chat: {
  commands: { roll: { description: 'roll a die', run: (world, id, args, ctx) => `🎲 ${1 + Math.floor(ctx.random() * 6)}` } },
  filter: (text, player) => text.replace(/darn/gi, '***'),   // null = drop the message
},
```

## Latency and load testing

| Tool | What it does |
| --- | --- |
| `?lag=150&jitter=40&loss=5` in the game URL | bad-network simulation in the browser: round-trip delay (ms), ± spread, % of dropped inputs; message order is preserved like on TCP |
| `GAIME_LATENCY_MS=120 npm run dev` | delay on the server side (for every client, `COLYSEUS_LATENCY`) |
| F3 in the example game | ping, patches/s, KB/s, inputs/s, resyncs + live server and worker costs |
| `npm run load -- --bots 50 --seconds 30` | real WebSocket bots: join time, RTT p50/p95/p99/max, messages and KB per bot, maximum tick/publish/patch, event-loop delay; warns when the tick does not fit its budget |
| `gaime load --input '{"mx":"$rand","fire":"$bool"}' --rate 30 --chat 0.5` | your own input template (`$rand`, `$rand*25`, `$bool`, `$int(a,b)`, `$pick(a|b)`), rate, chat |
| `npm run smoke` | correctness: patches, chat, reconnect, tab takeover, (`--hmr`) backend hot reload |

Bots join with the `ephemeral` option — their characters disappear after the test and do not litter the save.

When the tick cannot keep up: make `step` cheaper (spatial indexes, less frequent AI), move heavy work to workers, raise `publishEvery`, add large dictionaries to `entities`, hide server-only state with `hidden`, round more fields.
