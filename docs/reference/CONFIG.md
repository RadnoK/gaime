# Configuration reference

This page lists every configuration surface of a gaime game:

- the game definition,
- the network settings,
- the Vite plugin,
- the browser client,
- the environment of the supervisor, the game server and the Docker deployment,
- join options and HTTP endpoints.

For the concepts behind these settings, see [ARCHITECTURE.md](../ARCHITECTURE.md), [SERVER.md](../SERVER.md), [PROTOCOL.md](../PROTOCOL.md), [CLIENT.md](../CLIENT.md) and [DEPLOYMENT.md](../DEPLOYMENT.md). Gameplay helpers are in [KIT.md](../KIT.md).

- [GameDefinition](#gamedefinition)
- [GameContext](#gamecontext)
- [ChatCommand, AdminCommand, RequestHandler](#chatcommand-admincommand-requesthandler)
- [NetworkConfig](#networkconfig)
- [Vite plugin `gaime()`](#vite-plugin-gaime)
- [GameClientOptions and URL parameters](#gameclientoptions-and-url-parameters)
- [Environment variables](#environment-variables)
- [Join options](#join-options)
- [HTTP endpoints](#http-endpoints)

---

## GameDefinition

`defineGame<W, I>(game: GameDefinition<W, I>)` from `@gaime/core/server`. `W` is your world type (extends `BaseWorld`), `I` is the parsed input type. `defineGame` validates `name` and returns the definition unchanged. The server entry exports `server = createGameServer(game)`.

### Settings

Defaults are applied in `packages/core/src/server/room.ts`.

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `name` | `string` | required | Room name, checkpoint owner (a checkpoint of another game is refused) and browser storage prefix. Must match `/^[a-z0-9][a-z0-9-]{0,40}$/`. Keep it stable. |
| `maxPlayers` | `number` | unlimited | Maximum number of human players. With `keepPlayers: true` it counts players **online**. With `false` it counts every seat, and a player who already holds a seat can always come back. Bots are not counted. A rejected join gets HTTP 403 "The game is full". |
| `keepPlayers` | `boolean` | `true` | `true`: a character stays in the world after its player leaves, and returns with the same browser identity. `false`: leaving frees the seat (duels, board games). After a process restart, offline seats are kept for 60 s, then freed. |
| `tickRate` | `number` | `30` | Simulation ticks per second. `dt` passed to `step` is capped at 0.1 s. |
| `publishEvery` | `number` | `2` | Publish a network patch every N ticks (15 Hz at 30 ticks). Minimum 1. Commands and joins publish on the next tick regardless. |
| `reconnectSeconds` | `number` | `30` | Seconds a dropped connection keeps its session for an automatic reconnect. |
| `inputLeaseMs` | `number` | `400` | Continuous input older than this is dropped, so the player stops. The client repeats unchanged input every 150 ms to keep the lease. |
| `maxMessagesPerSecond` | `number` | `90` | Messages per second one client may send before Colyseus disconnects it. |
| `network` | `NetworkConfig` | see [below](#networkconfig) | What is synchronised and how. |

### Hooks

| Field | Signature | Meaning |
| --- | --- | --- |
| `createWorld` | `() => W` | A fresh world. Spread `baseWorld(SCHEMA)` into it. It is also used to fill fields missing from older saves. |
| `migrate?` | `(world: W) => W` | Upgrades an older world (checkpoint or hot-reload cache) in place. Missing fields are already filled from `createWorld()` and `createPlayer()`. Throw to refuse an incompatible save: the game pauses and the file is never deleted. |
| `prepare?` | `(world: W, ctx) => void` | Called on first start, after every load and after every hot reload (refresh catalogs, drop entities of removed features). |
| `createPlayer` | `(world: W, id: string, name: string, ctx) => Player` | Builds a new player. It is called on a first join, by `ctx.addBot`, and once per load with id `'template'` on a scratch world, to learn the default player fields. That template call gets a sandboxed `ctx`: `log`, `notify`, `emit`, `save`, `job`, `removePlayer` and `command` do nothing, `findPlayer` finds nothing, and `addBot` throws. Keep it free of side effects. The `name` it receives is already unique (see [Join options](#join-options)). |
| `onPlayerOnline?` | `(world, player, online: boolean, ctx) => void` | A player connected or disconnected (also bots and reconnects). |
| `onPlayerRemoved?` | `(world, player, ctx) => void` | The player is about to be deleted from the world. |
| `parseInput` | `(raw: unknown) => I \| undefined` | Validates and normalises raw client input. Return `undefined` to ignore it. Exceptions are logged and the input is ignored. |
| `step` | `(world, inputs: Readonly<Record<string, I>>, dt: number, ctx) => void` | Advances the simulation. It is not called while paused. An exception pauses the game (`pause.reason = 'error'`) until new code is loaded or the host resumes. |
| `command?` | `(world, playerId, command: { type: string, … }, ctx) => string \| void` | Discrete player actions. A returned string is sent to the player as a notice. An exception becomes a notice instead of crashing. Types starting with `$` are reserved for the engine (`$chat`, `$pause`, `$resume`). |
| `bot?` | `(world, botId, ctx) => I \| undefined` | Brain of bot players, called every tick (not while paused). It returns an input like a client would send. Discrete actions go through `ctx.command(botId, …)`. Defining it enables `/bot` in chat and `ctx.addBot`. |
| `requests?` | `Record<string, RequestHandler<W>>` | RPC endpoints for `client.request(name, payload)`. |
| `chat?` | `{ commands?: Record<string, ChatCommand<W>>; filter?(text, player): string \| null }` | Extra slash commands, and a filter for plain chat messages (return `null` to drop a message). |
| `admin?` | `Record<string, AdminCommand<W>>` | Operator commands for `gaime admin <name>` (admin token required). |
| `routes?` | `(app: express.Application) => void` | Extra HTTP routes on the game server. Registered once: changes need a process restart. |

```ts
export const game = defineGame<World, Input>({
  name: 'duel',
  maxPlayers: 2,
  keepPlayers: false,
  network: { entities: ['players', 'projectiles'], streams: ['feed', 'effects'], shared: ['catalog'], precision: { aim: 1, hp: 1 } },
  createWorld, createPlayer, parseInput, step, command,
});
```

## GameContext

`ctx` is passed to every hook. On the server it is backed by the room. `testContext(world, { random?, command? })` from `@gaime/core/server` builds one for unit tests.

| Member | Meaning |
| --- | --- |
| `world: W` | The live world (read-only reference; the object itself is mutable). |
| `log(text)` | A message in the world feed, visible to everyone. |
| `notify(playerId, text)` | A private toast (`notice` message) for one player. |
| `nextId(): number` | A fresh monotonic id (increments `world.seq`, persisted). |
| `random(): number` | A random number in [0, 1). In the room this is `Math.random`, which is not seeded. |
| `isHost(playerId)` | True for `world.hostId`. When the host goes offline, the role passes to the first online human player. |
| `removePlayer(playerId)` | Deletes the player and closes their connections. |
| `save()` | Asks for a checkpoint on the next tick. The engine also saves every ~2 s while time moves. |
| `emit(name, data?, playerId?)` | A one-off `event` message to everyone or to one player (sounds, screen shake). It is not stored in the world. |
| `job(promise, apply, fail?)` | Applies the result of asynchronous work on a later tick, inside the simulation. Pending jobs are dropped by a hot reload. |
| `findPlayer(nameOrId)` | Lookup by id, then by case-insensitive exact name, then by a unique name prefix. |
| `addBot(name?): string` | Adds a server-driven player (requires `GameDefinition.bot`, otherwise it throws). Id `bot-xxxxxxxx`, default name `Bot N`. A name another player already uses becomes `Name 2`, `Name 3`… |
| `isBot(playerId)` | True for players created by `addBot`. |
| `command(playerId, command)` | Runs `GameDefinition.command` as if `playerId` sent it, and returns its reply. Engine `$` commands are not handled. It never throws: an exception is logged and returned as the reply `Error in the code of command "<type>": <message>`, and the game is not paused. |

## ChatCommand, AdminCommand, RequestHandler

```ts
interface ChatCommand<W> {
  description: string;
  usage?: string;          // shown by /help, e.g. "<nick> <text>"
  host?: boolean;          // only the host may use it
  run(world: W, playerId: string, args: string, ctx: GameContext<W>): string | void;   // string = private answer
}

interface AdminCommand<W> {
  description: string;
  run(world: W, args: string[], ctx: GameContext<W>): unknown;   // printed as JSON by `gaime admin`; undefined → { ok: true }
}

type RequestHandler<W> = (world: W, playerId: string, payload: unknown, ctx: GameContext<W>) => unknown | Promise<unknown>;
```

- **Chat.** The built-in commands are `/help`, `/w`, `/me`, `/nick`, `/who`, `/kick` (host), `/pause` and `/resume` (host), and `/bot [name] | remove` (host, only when `bot` is defined). Game commands with the same name override built-ins. Command names are matched case-insensitively. Messages are limited to 200 characters, at most one message per 350 ms and 8 per 10 s. See [PROTOCOL.md](../PROTOCOL.md#chat).
- **Requests.** A thrown error rejects the client promise with its message. An unknown name is rejected with `Unknown request "<name>".` The client times out after 5000 ms by default (`request(name, payload, timeout)`).
- **Admin.** A thrown error becomes HTTP 400 with `{ error }`. The world is published after the command.

---

## NetworkConfig

This is `GameDefinition.network`, defined in `packages/core/src/shared/net.ts`. The server keeps the authoritative world untouched and sends each client a patch against a rounded, detached projection. Anything not listed in `entities` or `streams` is still synchronised, as a whole value whenever it changes. Details are in [PROTOCOL.md](../PROTOCOL.md#delta-sync).

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `entities` | `string[]` | `['players']` | Top-level `Record<id, object>` dictionaries, diffed per entity and per field. |
| `streams` | `string[]` | `['feed']` | Top-level arrays of immutable `{ id }` objects, sent as add/remove. |
| `precision` | `Record<string, number>` | `DEFAULT_PRECISION` | Field name → rounding factor for the network copy only (100 → 0.01). It is merged over the defaults and applies to that field name at any depth. A factor of `0` disables rounding for a field. |
| `hidden` | `string[]` | `[]` | Top-level keys that never leave the server. They are still saved in checkpoints. |
| `shared` | `string[]` | `[]` | Top-level keys that are replaced wholesale and never mutated (catalogs). They are compared by reference, sent when the reference changes, and **not stored in checkpoints** (rebuild them in `prepare`). |

`entities` and `streams` **replace** their defaults, so keep `'players'` and `'feed'` in them.

```ts
const DEFAULT_PRECISION = {
  x: 100, y: 100, z: 100, vx: 100, vy: 100, vz: 100, angle: 100, aim: 100, yaw: 100, time: 1000,
};
```

---

## Vite plugin `gaime()`

```ts
// games/<game>/vite.config.ts
import { defineConfig } from 'vite';
import { gaime } from '@gaime/core/vite';

export default defineConfig({ plugins: [gaime()] });
```

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `serverEntry` | `string` | `'/src/server/index.ts'` | Server entry exporting `server = createGameServer(game)`. |
| `registries` | `string[]` | `['src/server/registry.ts']` | Files that glob feature modules. They are touched when a feature file is added or removed, so new features load without a restart. |
| `features` | `RegExp` | `/[\\/]src[\\/]features[\\/][^\\/]+[\\/][^\\/]+\.ts$/` | Pattern of feature module files. |

The plugin does the following:

- It runs Colyseus inside the Vite dev server with server-side HMR (rooms keep their state).
- It aliases `@gaime/core` and `@gaime/core/{server,client,three,shared,worker,kit,ui,audio}` to the framework source.
- It debounces backend reloads by 120 ms.
- It serves on `0.0.0.0` with `strictPort`.
- It denies dev-server access to data files (`.env*`, keys, `.git`, `.gaime/data`, checkpoints, snapshots, `host.json`, `controls`).
- Production builds get sourcemaps. The client goes to `dist/client`, the server to `dist/server/server.mjs`, and `src/workers/*.ts` (relative to the Vite `root`) plus the worker bootstrap are bundled next to it.

Environment variables read by the plugin:

| Variable | Default | Effect |
| --- | --- | --- |
| `GAIME_PORT` | `5173` | Dev server port. A production `server.mjs` reads `GAIME_PORT`, then `PORT`, when it starts. The value at build time is only its default. |
| `GAIME_PUBLIC_URL` | none | Public address behind a reverse proxy. Its host is added to `server.allowedHosts`, and the HMR WebSocket uses its host, `wss` for `https:` and the URL port (default 443/80). |
| `GAIME_ALLOWED_HOSTS` | none | A comma-separated list of extra host names for `server.allowedHosts` (for example a Tailscale DNS name). |
| `GAIME_APPLYING_FILE` | none | While this file exists (the live supervisor is syncing a commit), backend reloads wait and are polled every 50 ms. |
| `GAIME_VERSION` | `'LOCAL'` | Inlined into client code as `import.meta.env.GAIME_VERSION`. |
| `GAIME_LATENCY_MS` | none | Copied to `COLYSEUS_LATENCY`: a simulated server-side delay for every client. |

---

## GameClientOptions and URL parameters

`new GameClient<World, Input, Command>(options)` from `@gaime/core/client`. See [CLIENT.md](../CLIENT.md).

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `game` | `string` | required | The same value as `GameDefinition.name`. It prefixes the browser storage keys (`gaime:<game>`). |
| `url` | `string` | `location.origin` | Game server address, `http(s)://` or `ws(s)://`. Used for the WebSocket and for `GET /gaime/room` (fetched over `http(s)`). |
| `identity` | `'browser' \| 'tab'` | `'browser'` | `browser`: one character per browser profile (ticket in `localStorage`). `tab`: every tab is a separate player (ticket in `sessionStorage`). |
| `simulate` | `{ lag?: number; jitter?: number; loss?: number }` | from the URL | Simulated bad network for testing prediction and interpolation. Each field overrides the matching URL parameter. |

URL parameters of the game page:

| Parameter | Effect |
| --- | --- |
| `?player=<name>` | Selects an additional local identity. The storage key becomes `gaime:<game>:<name>`. Characters other than letters, digits, `_` and `-` are removed, and the name is cut to 24 characters. Example: `?player=2` gives a second player on the same machine. |
| `?lag=<ms>` | Simulated **round trip** in ms. Half is applied to each direction, and message order is preserved. |
| `?jitter=<ms>` | Random ± spread added to each one-way delay. |
| `?loss=<percent>` | Percentage of **inputs** dropped (capped at 100). Commands, chat and requests are never dropped. |

---

## Environment variables

### Supervisor (`gaime host`)

`resolveConfig` is in `packages/host/src/supervisor.mjs`. It loads `.env` from the game directory and from the repository root first (`process.loadEnvFile`; variables already set in the environment win). Paths default relative to `<repo>/.gaime/<game>`.

| Variable | Default | Meaning |
| --- | --- | --- |
| `GAIME_GAME` | `name` in the game's `package.json`, else the directory name | Game key: the state directory name and the label in logs. |
| `GAIME_MODE` | `live` | `live`: Vite with HMR, each commit synced into the running tree. `release` (or `production`): a production build per commit and a short restart. Any other value means `live`. |
| `GAIME_PORT` | `5173` | Port of the game process (HTTP and WebSocket). Must be an integer 1–65535. The supervisor refuses to start when the port is taken. |
| `GAIME_GATES` | `auto` | Checks run before a commit goes live. `auto` or unset: `check` in live mode, none in release mode (the build is the gate). `none`: no gates. Otherwise a comma-separated list of npm scripts (`check,test`), each run as `npm run <script> --if-present` in the game directory with a 300 s timeout. |
| `GAIME_STATE_DIR` | `<repo>/.gaime/<game>` | Supervisor state: `host.json`, lock, `controls/`, `snapshots/`, `live/`, `releases/`, `deps/`, `live-version`, `applying`. |
| `GAIME_DATA_DIR` | `<state>/data` | Checkpoint and admin token. It is passed to the game process. |
| `GAIME_PUBLIC_DIR` | `<state>/public` | Files published for the static gateway (release mode; cleared in live mode). |
| `GAIME_REMOTE` | `origin` | Git remote to follow. If the remote does not exist, the local `HEAD` is used. |
| `GAIME_BRANCH` | `main` | Branch to follow. |
| `GAIME_POLL_MS` | `3000` | Interval between `git fetch` checks. Minimum 100. |
| `GAIME_START_TIMEOUT_MS` | `120000` | How long a fresh process may take until `/health` reports the new version. Minimum 1000. |
| `GAIME_HMR_TIMEOUT_MS` | `30000` | The same, for a hot reload in live mode. Minimum 1000. |
| `GAIME_SOAK_MS` | `2500` | After the version is confirmed, `/health` must still be OK after this delay. |
| `GAIME_SERVER_ENTRY` | `src/server/index.ts` | Server entry (relative to the game directory) that the live supervisor touches after a sync, to force a backend reload. Keep it in line with the Vite plugin's `serverEntry`. |

An empty numeric setting means the default. A value that is not a number, or is below its minimum, also falls back to the default, and the supervisor logs a warning (`GAIME_POLL_MS="3s" is not a number ≥ 100 — using 3000.`).

The supervisor passes the following variables to the game process:

| Context | Variables |
| --- | --- |
| Live | `NODE_ENV=development`, `GAIME_PORT`, `GAIME_DATA_DIR`, `GAIME_VERSION=<sha>`, `GAIME_VERSION_FILE=<state>/live-version`, `GAIME_APPLYING_FILE=<state>/applying` |
| Release | `NODE_ENV=production`, `GAIME_PORT`, `GAIME_DATA_DIR`, `GAIME_VERSION=<sha>` |
| Release build | `NODE_ENV=production`, `GAIME_VERSION`, `GAIME_PORT` |

The rest of the environment is inherited.

### Game server (`npm run dev` / `npm start`)

| Variable | Default | Meaning |
| --- | --- | --- |
| `GAIME_DATA_DIR` | `.gaime/data` (relative to the working directory) | Holds `checkpoint.json` and `admin-token`. |
| `GAIME_VERSION` | `LOCAL` | Code version reported by `/health` and in the welcome message. |
| `GAIME_VERSION_FILE` | none | A file whose content (when present and non-empty) wins over `GAIME_VERSION`. It is re-read on every server hot reload, which is how the live supervisor confirms that a new commit is loaded. |
| `GAIME_ADMIN_TOKEN` | generated | Bearer token for `/gaime/admin/*`. When unset, 24 random bytes (hex) are generated once and kept in `<data>/admin-token` (mode 600). |
| `GAIME_LATENCY_MS` | none | Simulated server-side delay (sets `COLYSEUS_LATENCY`). |
| `GAIME_APPLYING_FILE` | none | See the [Vite plugin](#vite-plugin-gaime) (dev only). |
| `GAIME_PUBLIC_URL` | none | See the [Vite plugin](#vite-plugin-gaime) (dev only). |
| `GAIME_ALLOWED_HOSTS` | none | See the [Vite plugin](#vite-plugin-gaime) (dev only). |
| `GAIME_PORT` | `5173` | Server port, for `npm run dev` and for `npm start` (a production build reads `GAIME_PORT`, then `PORT`, at start; the port at build time is the default). |

The `gaime` CLI additionally reads the following:

- `GAIME_URL`: base URL for admin commands, `status`, `smoke` and `load` (default `http://127.0.0.1:<port>`).
- `GAIME_ADMIN_TOKEN` and `GAIME_DATA_DIR`: to find the token.
- `GAIME_LOAD_INPUT`: the default `--input` template of `gaime load`.

### Docker deployment

These variables are set in `/srv/gaime/<game>/.env` (template: `deploy/docker/env.example`) and used by `deploy/docker/compose*.yml`. See [DEPLOYMENT.md](../DEPLOYMENT.md#a-vps-with-docker-recommended).

| Variable | Default | Used by | Meaning |
| --- | --- | --- | --- |
| `GAME` | required | `compose.yml`, `compose.traefik.yml` | Directory in `games/`. It sets the project name (`gaime-<GAME>`), the working directory `/app/games/<GAME>`, the gateway's published files `./repo/.gaime/<GAME>/public`, and the Traefik router name. It must equal the supervisor's game key (`package.json` name). |
| `DOMAIN` | required | `compose.yml`, Traefik, Caddy | Public domain. It is the default for `GAIME_PUBLIC_URL` (`https://<DOMAIN>`), the Traefik `Host()` rule and the Caddy site. |
| `COMPOSE_FILE` | `compose.yml:compose.traefik.yml` (in the example) | Docker Compose | HTTPS variant. `compose.yml:compose.traefik.yml` uses an existing Traefik. `compose.yml:compose.caddy.yml` runs its own Caddy on ports 80 and 443. `compose.yml` alone means your own proxy points at `GATEWAY_BIND`. |
| `GAIME_MODE` | `live` | game service | See the supervisor table. |
| `GAIME_GATES` | `auto` | game service | See the supervisor table. |
| `GAIME_BRANCH` | `main` | game service | See the supervisor table. |
| `GAIME_POLL_MS` | `3000` | game service | See the supervisor table. |
| `GAIME_REMOTE` | `origin` | game service | See the supervisor table. |
| `GAIME_SOAK_MS`, `GAIME_START_TIMEOUT_MS`, `GAIME_HMR_TIMEOUT_MS`, `GAIME_SERVER_ENTRY` | empty (the built-in default) | game service | See the supervisor table. |
| `GAIME_ALLOWED_HOSTS` | empty | game service | See the Vite plugin table. |
| `GAIME_LATENCY_MS` | empty | game service | See the game server table. For testing only, never in production. |
| `GAIME_ADMIN_TOKEN` | empty (a generated token is used) | game service | See the game server table. |
| `GAIME_PUBLIC_URL` | `https://<DOMAIN>` | game service | See the Vite plugin table. |
| `EDGE_NETWORK` | `edge` | `compose.traefik.yml` | External Docker network shared with Traefik. |
| `TRAEFIK_ENTRYPOINT` | `websecure` | `compose.traefik.yml` | Traefik entrypoint of the router. |
| `TRAEFIK_CERTRESOLVER` | `letsencrypt` | `compose.traefik.yml` | Traefik certificate resolver. |
| `GATEWAY_BIND` | `127.0.0.1:8080` | `compose.yml` | Host address and port of the nginx gateway. Use a different port per game. |

The game container sets several variables to fixed values:

- `GAIME_PORT=5173`
- `GAIME_DATA_DIR=/data` (mounted from `./data`)
- `GAIME_PUBLIC_DIR=/app/.gaime/<GAME>/public` (the directory the gateway serves)
- `HOME=/tmp`
- `NPM_CONFIG_CACHE=/app/.gaime/npm-cache`
- `GIT_SSH_COMMAND` (deploy key from `./ssh`)

Only the variables listed in `compose.yml` reach the container. It passes through every variable in the table above (all listed in `deploy/docker/env.example`). An empty value means the built-in default. Anything else (for example `GAIME_STATE_DIR`) has two options:

- Add it to the `environment:` block of `compose.yml`.
- Put it into `repo/.env` or `repo/games/<GAME>/.env`, which the supervisor loads itself.

---

## Join options

These are the options a client passes to `joinById(roomId, options)`. `GameClient` sends `name` and `ticket` automatically.

| Option | Type | Meaning |
| --- | --- | --- |
| `ticket` | `string` | **Required.** A private, persistent browser identity matching `/^[A-Za-z0-9_-]{16,64}$/` (`GameClient`: 18 random bytes, base64url). The same ticket always maps to the same player. A second connection with the same ticket takes over the character, and the older one is closed with "The game was opened in another tab". A missing or invalid ticket gets HTTP 400. |
| `name` | `string` | Display name. Whitespace is collapsed and trimmed, and the name is cut to 24 characters. Empty means `Player N`. A new player whose name is already taken (case-insensitive) gets `Name 2`, `Name 3`… For an existing player, a different name renames them, unless another player uses it: then they keep their current name and get a notice. |
| `ephemeral` | `boolean` | When `true`, a newly created player is a test player: no "joined" feed message, and it is deleted when its connection leaves and whenever the room starts. `gaime smoke` and `gaime load` use it. |

---

## HTTP endpoints

These are served by the game process (`createGameServer`). Every response has `Cache-Control: no-store`.

| Method and path | Auth | Response |
| --- | --- | --- |
| `GET /health` | none | `{ ok, game, version, error, uptime }`. `ok` is false while a code error is recorded. `version` is the loaded code version. `uptime` is in seconds. The supervisor and the Docker health check use it. |
| `GET /gaime/room` | none | `{ roomId }` of the single shared room. The room is created on demand. On failure it returns `503` with `Retry-After: 2`. |
| `GET /gaime/stats` | none | Over a 10 s window: `{ clients, tickRate, tickMs, publishMs, patchBytes, eventLoopDelayMs, memoryMb, workers }`. `tickRate` is the game's ticks per second. `tickMs`, `publishMs` and `patchBytes` are `{ avg, max }`. `eventLoopDelayMs` is `{ p50, p99, max }`, the worst of the last complete 10 s window and the current one. Reading is non-destructive, so several readers see the same numbers. `workers` is `PoolStats[]`. See [SERVER.md](../SERVER.md#http). |
| `GET\|POST /gaime/admin/:action` | `Authorization: Bearer <token>` | Operator API used by the `gaime` CLI. The POST body is JSON (max 256 kB). A wrong token gets `401`. Errors get `400 { error }`. The nginx gateway answers `404` for `/gaime/admin/` from outside. |
| everything from `routes(app)` | yours | Game-defined routes. |
| `/`, `/index.html`, `/assets/*`, static files | none | Production only: `dist/client`. `index.html` is `no-store`, `/assets` is immutable for one year, other files are cached for 5 min. |

Admin actions (`admin()` in `packages/core/src/server/room.ts`):

| Action | Body | Result |
| --- | --- | --- |
| `players` | none | `[{ id, name, online, host }]` |
| `world` | none | The full world projection, **including `hidden` keys**, rounded like the network copy. |
| `say` | `{ text }` | Feed announcement `📣 <text>` (280 characters max). Returns `{ ok: true }`. |
| `kick` | `{ player }` (id or name) | Removes the player. Returns `{ removed: <name> }`. |
| `pause` | none | Pauses the simulation (`reason: 'host'`). Returns `{ paused: true }`. |
| `resume` | none | Resumes the simulation and clears the recorded error. It fails while a save could not be loaded. Returns `{ paused: false }`. |
| `save` | none | Writes a checkpoint now. Returns `{ saved: true }`. |
| `command` | `{ name, args?: string[] }` | Runs `GameDefinition.admin[name]`. Returns its result, or `{ ok: true }`. |
| `commands` | none | `{ [name]: description }` of `GameDefinition.admin`. |

Arguments are read from the JSON body, so actions that need them must use `POST`. With `GET`, the body is empty.

```sh
curl -X POST -H "Authorization: Bearer $(cat .gaime/data/admin-token)" -H 'content-type: application/json' \
  -d '{"name":"wave","args":["5"]}' http://127.0.0.1:5173/gaime/admin/command
```
