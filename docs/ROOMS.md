# Rooms: shared worlds and matches

A game runs in one of two room modes, chosen in its definition:

```ts
defineGame({
  name: 'arena',
  rooms: { mode: 'matches', size: 4 },   // default: { mode: 'shared' }
  …
});
```

| | `shared` (default) | `matches` |
| --- | --- | --- |
| Rooms | exactly one, for everybody | as many as needed, `size` seats each |
| World | persistent: `checkpoint.json` every ~2 s, restored on start | per room, ephemeral: no files; a hot reload keeps it, a process restart ends it |
| Joining | everybody joins the one room | matchmaking fills the fullest open room, or an invite code for a private match |
| Lifetime | forever | created on demand, closed when empty for a while |
| `ctx.room` | `{ id }` | `{ id, code? }` |
| `ctx.lockRoom(locked)` | no effect (a warning) | stops matchmaking into the room |
| Scaling | one process | several processes with Redis ([below](#scaling-out-with-redis)) |

Use `shared` for persistent worlds that people drop in and out of (the templates). Use `matches` for sessions with a start and an end: rounds, duels, parties with friends, anything where a few players play together and then leave.

Everything inside a room is the same in both modes: one `Engine` per room with its own world, clock, timers, bots and modules. Game code does not change — `createWorld()` makes the world of each new match.

## Seats

- `size` counts **connections of human players**. Bots (`ctx.addBot`, `/bot`) never take a seat.
- A seat is a Colyseus seat reservation (`maxClients = size`). It is taken when `/gaime/room` hands it out, before the WebSocket even connects, so parallel joins never overfill a room — also across processes.
- A player whose connection dropped keeps the seat for `reconnectSeconds` (default 30).
- A full room is locked by Colyseus and unlocks itself when a seat frees up.
- `maxPlayers` still applies inside a room (it counts characters, see `keepPlayers`).
- A second tab of the same browser takes over the character only if the room has a free seat for it (in a full room the first tab keeps playing).

## Matchmaking

`POST /gaime/room` (what `GameClient` does) finds a room **and** reserves a seat in one request:

1. `room`: the room this browser tab played in (after the reconnection token expired, e.g. a reload much later). It gets back in if the room still exists and either is open or already has a character for this ticket.
2. `code`: the private match with this invite code. Unknown code → `404`; a full match or one that is locked and does not know this player → `403`.
3. `create: 'private'`: a new private match with a fresh code.
4. Otherwise public matchmaking: the open room (not private, not locked, a free seat) with the **most players**, then the oldest; a new room if there is none. Public matchmaking is serialised per process, so two players arriving together land in the same room.

`GET /gaime/room` answers the same questions without a seat — `{ roomId, code?, mode, size }` — for tools and older clients that then `joinById`. A room it names can fill up before the join; the join fails and the tool asks again. `?code=ABCDE` finds a private match, `?create=private` creates one. See [PROTOCOL.md](PROTOCOL.md#joining).

Rooms are created only by `/gaime/room`: a room refuses to start from Colyseus' public `/matchmake/create` route.

## Invite codes

- 5 characters from `ABCDEFGHJKMNPQRSTUVWXYZ23456789` (no `I L O 0 1`): easy to read out and type. Lookups ignore case, spaces and dashes (`abc-de` finds `ABCDE`).
- Unique among live rooms; a code dies with its room.
- Private matches never appear in public matchmaking. `rooms: { mode: 'matches', size, private: false }` turns them off (`403`).

In the browser:

```ts
const net = new GameClient<World>({ game: 'arena' });                              // ?code= in the page URL → that match
const host = new GameClient<World>({ game: 'arena', match: { create: 'private' } }); // a new private match
await host.join('Ola');
host.room;    // { id: 'xK3…', code: 'M7QTB' }
host.invite;  // 'https://arena.example.com/?code=M7QTB' — share it; undefined in public matches and shared games
```

`GameClient` reads `?code=` from the page URL by default, so an invite link opens straight into the match. A wrong or expired code ends in the `error` state (no endless retry).

## Locking

```ts
on: {
  'round.started': (_data, ctx) => ctx.lockRoom(true),    // nobody new joins a running round
  'round.ended': (_data, ctx) => ctx.lockRoom(false),     // open for the next one
},
```

- A locked room gets nobody from matchmaking, by code or by `joinById`.
- Players who already have a character in it (their browser ticket is known) still get back in: by reconnection token, or later through `POST /gaime/room` with `room`.
- The lock is Colyseus' explicit room lock plus `locked` in the listing (`gaime rooms`). It survives hot reloads.
- Unlocking a full room leaves it locked by Colyseus until a seat frees up.

## Lifetime

- A room is created when matchmaking needs one (or for a private match).
- It closes when it has had **no connection and no pending seat** (reservations, players within `reconnectSeconds`) for `GAIME_EMPTY_ROOM_SECONDS` (default 30). A room with only bots counts as empty.
- The world of a match lives in memory: no checkpoint files. A backend hot reload (live mode) caches and restores every room with its world, identities, sessions and lock; clients reconnect by themselves. A process restart — every deploy in release mode, a crash — ends the matches of that process; clients then find a new match.
- `GAIME_MAX_ROOMS` (default 1000): beyond this many rooms `/gaime/room` refuses new ones with `503`.

## Identity and reconnection

- The browser ticket (localStorage, per `?player=` slot) maps to a player id **per room**; the same browser has independent characters in different matches.
- The tab remembers the room id and the Colyseus reconnection token (sessionStorage). A dropped connection reconnects to the same room; after the token expired it asks for the same room by id.
- `net.leave()` forgets the room: the next `join` finds a new match. A new tab starts fresh as well.

## Operators: admin API and CLI

Every admin action takes an optional room (`?room=<id|code>`; `--room` in the CLI). Without it: the shared room, or the only room; with several matches running the command asks you to choose.

```sh
npx gaime rooms                         # id, code, players, connections, since, (private, locked, full)
npx gaime players --room M7QTB          # by invite code
npx gaime say --room xK3aZ1pQe "Server restarts in 5 minutes"
npx gaime world --room M7QTB players
npx gaime admin --room M7QTB reset      # the game's own admin commands
```

`/gaime/admin/rooms` → `[{ id, code?, clients, players, locked, full, private, createdAt, process }]` (all processes). `/gaime/admin/room?room=…` → one room's details. `/health` and `/gaime/stats` include `rooms` (rooms in this process); in matches mode `/gaime/stats` → `clients` is the sum over the process's rooms.

`gaime smoke` detects matches mode from `/gaime/room`: it checks a private match (create + join by code), patches, chat, reconnect, the tab takeover, and public matchmaking (two players share a room; with `size: 2` a third gets a new one). `gaime load` matchmakes every bot like a player and reports how many rooms they filled.

## Scaling out with Redis

A shared game is one room and runs in one process. A matches game can spread its rooms over several processes on one or more machines:

```text
                      ┌────────────── gateway (nginx) ──────────────┐
browser ── page, /gaime/room, /matchmake/* ──▶ process 0 (:5173)      │
        ── WebSocket /p1/<process>/<room> ──▶ process 1 (:5174)      │
        ── WebSocket /p2/<process>/<room> ──▶ process 2 (:5175)      │
                      └──────────────────────────────────────────────┘
                                   │ room listing, IPC
                                 Redis
```

- `GAIME_REDIS_URL` (production builds, matches mode): the processes share the room listing and talk to each other through `@colyseus/redis-presence` and `@colyseus/redis-driver`. Matchmaking on any process sees every room; a new room is created on the process with the fewest rooms; seats are reserved by the process that owns the room.
- `GAIME_PUBLIC_ADDRESS` (host[:port][/path], no scheme): where clients reach this process's rooms. The seat reservation carries it, and the Colyseus client connects there (`wss://<address>/<processId>/<roomId>`).
- Reconnection, `joinById` and the admin API work from any process (admin actions for a room elsewhere go through Redis).
- The supervisor does the wiring: `GAIME_PROCESSES=n` in release mode starts n processes on consecutive ports with `GAIME_PUBLIC_ADDRESS=<public host>/p<i>`, and the Docker gateway routes `/p<i>/` to them — [DEPLOYMENT.md](DEPLOYMENT.md#scaling-out).
- Use one Redis (or one Redis database, `redis://host:6379/<db>`) per game.

## Limits

- Matches are not persisted: a restart or a release deploy ends them (hot reloads in live mode do not).
- `/health` → `error` and `disabled` are per process: an error that pauses one match shows up there (and counts against a deploy), and a code load clears it for every room.
- `/gaime/stats` costs (`tickMs`, `parts`, `engine`) mix the rooms of the process.
- Live mode (Vite) runs one process; `GAIME_REDIS_URL` is ignored there.
- Matchmaking is serialised per process. Behind the gateway every `/gaime/room` reaches process 0; clients that ask different processes at the same moment may open two half-empty rooms instead of one (never an overfull one).
- The Docker gateway routes up to 16 processes (`/p0/` … `/p15/`).
