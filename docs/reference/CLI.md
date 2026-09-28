# CLI reference

This page covers the `gaime` command line tool (`packages/host/bin/gaime.mjs`, with helpers in `packages/host/src/*.mjs`) and the npm scripts that wrap it. It is split into three parts:

- **Deploy supervisor.** How it works is described in [DEPLOYMENT.md](../DEPLOYMENT.md).
- **Admin API.** What games can add to it is described in [SERVER.md](../SERVER.md#operator-commands).
- **Environment variables.** Every variable is listed in [CONFIG.md](CONFIG.md#environment-variables).

## Running `gaime`

| Where | How |
| --- | --- |
| A game directory (`games/<name>`) | `npx gaime <command>`. The binary comes from the `@gaime/host` dependency of every game. |
| The same, through the game's scripts | `npm run host`, `npm run smoke`, `npm run load` inside `games/<name>` |
| The repo root | `npm run <script> -- [<game>] [args]` for `dev`, `host`, `smoke`, `load` and `build:game` (see [`scripts/game.mjs`](#scriptsgamemjs)). `npm run gaime -- <command>` and `npm run new-game -- <name>` also run from the root. |
| Docker (`deploy/docker/compose.yml`) | `docker compose exec game node /app/packages/host/bin/gaime.mjs <command>`, run from `/srv/gaime/<game>`. The container's working directory is already `/app/games/<GAME>`, and `GAIME_DATA_DIR=/data` and `GAIME_PORT=5173` are set. |

Most commands depend on the **current directory**. The supervisor and the admin commands work out the game from it, so run them inside the game directory. `npm run gaime -- …` runs in the repo root, which is only right for `new`, `help`, and `smoke`/`load` against the default URL.

### Configuration and target resolution

Every command except `new` and `help` first tries `resolveConfig()` on the current directory:

1. It finds the git top level (`git rev-parse --show-toplevel`). If this fails, the directory is not a git repository: `host`, `status` and the control commands fail, while the admin, `smoke` and `load` commands fall back to defaults.
2. It loads `.env` from the current directory and then from the repo root (`process.loadEnvFile`), so settings such as `GAIME_URL`, `GAIME_PORT` and `GAIME_ADMIN_TOKEN` can live there.
3. It sets the game name from `GAIME_GAME`, otherwise the `name` in `./package.json`, otherwise the directory name. This gives:
   - state directory: `GAIME_STATE_DIR` or `<repo>/.gaime/<game>`, which contains `host.json`, `controls/`, `snapshots/`, `live/` and `releases/`;
   - data directory: `GAIME_DATA_DIR` or `<state>/data`.

The admin commands, `smoke` and `load` then pick their target with `target()`:

| Value | Resolution (first match wins) |
| --- | --- |
| URL | 1. `GAIME_URL`<br>2. `http://127.0.0.1:<port>`, where the port is the first match of `GAIME_PORT`, then the `port` in the supervisor's `host.json` (only while that supervisor's PID is alive), then `5173` |
| Admin token | Candidates, tried in this order: 1. `GAIME_ADMIN_TOKEN`<br>2. the `admin-token` file in `$GAIME_DATA_DIR`<br>3. the supervisor's data directory (`<repo>/.gaime/<game>/data`) and `./.gaime/data` (the data directory of a local `npm run dev`): the supervisor's first while it is alive, otherwise `./.gaime/data` first |

Admin commands send the first candidate and move on to the next one after an HTTP 401, so a stale token file does not hide a valid one. The game server creates the token file itself on first start, unless `GAIME_ADMIN_TOKEN` is set. The nginx gateway blocks `/gaime/admin/` from outside, so inside Docker you run admin commands in the container.

### Exit codes

| Code | When |
| --- | --- |
| `0` | Success. Also `gaime`, `gaime help`, `gaime --help`, `status` without state, and `new` without a name (lists templates). |
| `1` | Any error, printed to stderr as `gaime <command>: <message>`. This covers an unreachable game, a missing or wrong token, a server-side error and bad usage. It also covers an unknown command (the help is printed), a control command sent while the supervisor is not running or reported as failed by it, a failing `smoke`, and a `load` run in which any bot failed to join or disconnected. |

## Command summary

| Command | Group | Needs |
| --- | --- | --- |
| [`host`](#host) | supervisor | game directory in a git repository, free port |
| [`status [--json]`](#status) | supervisor | game directory |
| [`rollback`](#control-commands-rollback-resume-pause-redeploy-restart), [`resume`](#control-commands-rollback-resume-pause-redeploy-restart), [`pause`](#control-commands-rollback-resume-pause-redeploy-restart), [`redeploy`](#control-commands-rollback-resume-pause-redeploy-restart), [`restart`](#control-commands-rollback-resume-pause-redeploy-restart) | supervisor | running supervisor for this game |
| [`rooms`](#rooms) | admin API | running game plus token |
| [`players`](#players) | admin API | running game plus token |
| [`say <text>`](#say) | admin API | running game plus token |
| [`kick <nick>`](#kick) | admin API | running game plus token |
| [`world [key]`](#world) | admin API | running game plus token |
| [`game pause\|resume\|save`](#game) | admin API | running game plus token |
| [`admin [command] [args…]`](#admin) | admin API | running game plus token |
| [`replay [reason]`, `replay --list`](#replay) | admin API | running game plus token |
| [`smoke [url] [--hmr]`](#smoke) | tests | running game |
| [`load [url] [options]`](#load) | tests | running game |
| [`new <name> [--title] [--from]`, `new --list`](#new) | scaffolding | the repository |

Argument parsing: `--bots`, `--seconds`, `--rate`, `--input`, `--chat`, `--title`, `--from` and `--room` take a value. `--json`, `--hmr` and `--list` (`new`, `replay`) are switches. All other arguments that do not start with `--` are positional. If a flag appears twice, **the last occurrence wins**, so arguments after `npm run <script> --` override a preset in the script.

## Supervisor

### host

```sh
cd games/starter && npx gaime host        # or: npm run host (root or game dir)
```

Starts the deploy supervisor in the foreground. `gaime start` is an alias. The supervisor:

- takes a lock in `<state>/host.lock` and fails if another supervisor for this game is alive;
- checks that `GAIME_PORT` (default 5173) is free and fails if it is not (it never kills other processes);
- deploys the newest commit of `GAIME_REMOTE/GAIME_BRANCH` (default `origin/main`), or the local `HEAD` when there is no remote;
- polls for new commits every `GAIME_POLL_MS` (default 3000) and deploys each one in `live` or `release` mode (`GAIME_MODE`);
- restarts a crashed game with backoff and processes control commands.

It runs committed code only (`git archive`) and never touches the working tree. `SIGINT`/`SIGTERM` stop the game process and the supervisor. It exits 0 after a normal stop and 1 if startup fails (port taken, already running, first deploy failed). Deploy mechanics: [DEPLOYMENT.md](../DEPLOYMENT.md).

### status

```sh
npx gaime status
npx gaime status --json
docker compose exec game node /app/packages/host/bin/gaime.mjs status
```

Reads `<state>/host.json` and asks the game's `/health` on `GAIME_URL`, or else `http://127.0.0.1:<port>`. It prints the following:

```text
starter · live · supervisor PID 4242 · running
version: 1a2b3c4d   previous: 9f8e7d6c   game /health: ok 1a2b3c4d · 1 room
processes: p0:5173 ok 1a2b3c4d 3 rooms   p1:5174 ok 1a2b3c4d 2 rooms   (only with GAIME_PROCESSES > 1)
last failed commit: 5e6f7a8b — gate "check" … (only if any)
last error: … (only if different from the failed commit's error)
  2026-09-28 10:12:03  1a2b3c4d  hot reload 3.1s  Ola: add bog creature
  … (up to 8 history entries: time, sha, result [seconds], author: subject [— error])
```

The room count comes from `/health` (rooms in that process). With several processes the `processes` line asks each one's `/health` (not when `GAIME_URL` is set). The first line also shows `supervisor not running` when the PID is dead, and `UPDATES PAUSED` after `pause` or `rollback`. The status field is one of `starting`, `running`, `preparing`, `applying`, `restarting`, `crashed` or `stopped`. History results are `hot reload`, `restart`, `superseded` or `failed`. `--json` prints only JSON instead: the whole state object plus `running` (boolean) and `health` (the `/health` JSON or `null`). If the supervisor has never run, it prints `No state in <stateDir>. The supervisor has not run yet.` (with `--json`: `{ "state": null, "stateDir": "…" }`) and exits 0.

### Control commands: rollback, resume, pause, redeploy, restart

```sh
npx gaime rollback
docker compose exec game node /app/packages/host/bin/gaime.mjs resume
```

Each command writes a control file into `<state>/controls/`. The running supervisor processes it within about 200 ms, or after the deploy it is busy with. The CLI first checks that the supervisor PID in `host.json` is alive (otherwise: `The supervisor is not running — start it first: gaime host`, exit 1). It then waits for the supervisor's acknowledgement, which is recorded as `control` in `host.json` (`{ id, command, at, ok, error? }`), for up to 30 s (`rollback`: 180 s):

| Outcome | Output | Exit code |
| --- | --- | --- |
| Handled | `Done: <command>.` | 0 |
| Failed | `<command> failed: <error>` on stderr (for example, nothing to roll back to) | 1 |
| Not handled in time | `Requested "<command>" — the supervisor has not handled it yet (busy deploying?). See: gaime status` | 0 |

| Command | Effect |
| --- | --- |
| `pause` | Stops following the branch: no new deploys. The game keeps running. |
| `resume` | Follows the branch again and clears the last error. |
| `redeploy` | Forgets the last attempted and failed commit and unpauses. The newest commit is retried on the next poll, unless it is already the current version. |
| `restart` | Stops the game process. The supervisor starts the current version again from the last checkpoint. |
| `rollback` | Pauses updates and returns to the previous version. **live** mode syncs the previous tree through HMR without gates, and the world stays. **release** mode starts the previous release together with the checkpoint snapshot taken before the following deploy, so progress since then is lost. Either way there is then no previous version any more, so a second `rollback` is refused (no ping-pong between two versions). If there is nothing to go back to, it fails with `There is no previous version to roll back to.` (live) or `There is no previous release to roll back to.` (release). After fixing the problem, push and run `resume`. |

## Admin API commands

These commands talk to `GET` or `POST <url>/gaime/admin/<action>` with `authorization: Bearer <token>` and a 10 s timeout (see [target resolution](#configuration-and-target-resolution)). Errors: `No admin token: set GAIME_ADMIN_TOKEN or run inside the directory of a game that is running.`, `Cannot reach <url>: …`, `Missing or wrong admin token …` (HTTP 401), or the server's message (HTTP 400). Each ends with exit 1. The admin API always talks to the room that is live right now, including after hot reloads.

Every admin command takes `--room <id|code>` (a room id, or the invite code of a private match; case-insensitive). Without it the command goes to the shared room, or to the only match; with several matches running it fails with `<n> rooms are running — choose one with --room <id|code> (gaime rooms).` An unknown room: `No room "<x>" (see gaime rooms).` With several processes ([Scaling out](../DEPLOYMENT.md#scaling-out)) any room is reachable through process 0. [ROOMS.md](../ROOMS.md#operators-admin-api-and-cli).

### rooms

```sh
npx gaime rooms
```

Lists every room of the game (all processes): id, invite code (`-` for a public match), human players in the world, connections (including reserved seats), creation time (UTC), and `private` / `locked` / `full`. A shared game has one room. `No rooms.` when none runs.

```text
xK3aZ1pQe  -        2 players    2 connections  since 18:02:11  (full)
b7Qm0Lr2T  M7QTB    1 players    1 connections  since 18:04:40  (private, locked)
```

### players

```sh
npx gaime players
npx gaime players --room M7QTB
```

Prints one line per player in the world: `●` (online) or `○` (offline), `👑` for the host, then the name and the id. If the world has no players it prints `No players.`

```text
● 👑 Ola  k3j9x0
○ Bob  a81c2m
```

### say

```sh
npx gaime say "Restart at 8 pm"
```

Posts `📣 <text>` to the game feed, cut to 280 characters and published immediately. All positional arguments are joined with spaces. Prints `{ "ok": true }`.

### kick

```sh
npx gaime kick Ola
```

Removes a player. Their client gets `removed` and stops reconnecting. The argument matches, in this order: a player id, an exact name (case-insensitive), or a name prefix that is unique. Prints `{ "removed": "<name>" }`. If nothing matches, the error is `No player named "<nick>".`

### world

```sh
npx gaime world                 # whole world
npx gaime world players         # one top-level field
npx gaime world crystal.hp      # dotted path
```

Prints the world as JSON. This is the network projection: numbers are rounded with the game's `network.precision`, but `hidden` fields are **included**. The optional key is a dotted path. A path that does not exist prints `undefined`.

### game

```sh
npx gaime game pause     # { "paused": true }  — world.pause = { reason: 'host' }
npx gaime game resume    # { "paused": false } — also clears an error pause
npx gaime game save      # { "saved": true }   — writes the checkpoint now
```

`resume` fails with `The save did not load — fix the code first.` while the room is frozen on an unreadable checkpoint. Any other action prints `Usage: gaime game pause|resume|save` and exits 1.

### admin

```sh
npx gaime admin              # list the game's commands
npx gaime admin wave 5       # run GameDefinition.admin.wave with args ['5']
```

Without a name, it lists `GameDefinition.admin` as `name  description`, or prints `The game defines no admin commands (GameDefinition.admin).` With a name, it runs that command. The remaining positional arguments are passed as strings. It prints the command's return value as JSON, or `{ "ok": true }` if the command returns nothing, and publishes the world. An unknown name fails with `Unknown admin command "<name>". Available: …`. Defining commands: [SERVER.md](../SERVER.md#operator-commands).

### replay

```sh
npx gaime replay                     # save the flight recording of the room now (reason "manual")
npx gaime replay bots stuck at wave 3   # the reason becomes part of the file name
npx gaime replay --list              # saved recordings, oldest first
npx gaime replay --room M7QTB        # a specific match
```

Saves the room's flight recording — the last `record.minutes` (default 10) of inputs, commands, joins, operator actions and worker results, with world snapshots — to `<data>/replays/<timestamp>-[<room id>-]<reason>.json` and prints the path plus a hint:

```text
Saved /data/replays/2026-09-28T18-02-11-512Z-manual.json
Replay it in a test: replay(game, JSON.parse(readFileSync(file, 'utf8'))) — docs/SIMULATION.md#determinism-and-replays
```

All positional arguments are joined into the reason (non-word characters become `-`, cut to 40). The server keeps the newest 20 files. It also saves recordings by itself when the game pauses on an error (`…-error.json`) or a module is switched off (`…-module-<id>.json`), at most once a minute per room. A game with `record: { enabled: false }` fails with `This game does not record (GameDefinition.record.enabled is false).`

`--list` prints the file paths (`No recordings yet.` when there are none). The list covers the whole data directory, but the request still goes through a room, so with several matches running it needs `--room` like any admin command.

Copy the file to your machine (on a Docker server it is in `/srv/gaime/<game>/data/replays/`, the container's `/data`; locally in the game's `.gaime/data/replays/`) and replay it with the same code version — [SIMULATION.md](../SIMULATION.md#determinism-and-replays), [TESTING.md](../TESTING.md#what-to-test).

## Tests

### smoke

```sh
npm run dev                        # in one terminal
npm run smoke                      # root: default game; or: npm run smoke -- duel
npx gaime smoke http://localhost:5173 --hmr
```

This is an end-to-end check with real Colyseus WebSocket clients. The URL is the positional argument, or `target().url` if none is given. The Colyseus SDK is resolved from the current directory's `package.json`. Clients join with the `ephemeral` option, so their characters are removed and do not stay in the save. The steps:

1. `/health` reports `ok: true`.
2. Clients `Smoke A` and `Smoke B` join. A sees B online through an entity patch. Prints `✓ two clients, welcome snapshot and entity patches`.
3. A sends a `$chat` command and B receives it through a feed stream patch. Prints `✓ commands and stream patches`.
4. A's socket is dropped. B sees A offline. A reconnects with its token as the same player, and B sees A online again. Prints `✓ drop + reconnect keeps the identity`.
5. A new connection with A's ticket gets A's player id. Prints `✓ same browser identity takes over the character`.
6. With `--hmr`, the command touches `./src/server/index.ts`, so it must run in the game directory against a local Vite dev server or live-mode game whose files are that directory. It then waits (up to 20 s) for B's fresh `welcome` and a feed item matching `New game code`, checks that the identities survived and that `/health` is still ok. Prints `✓ backend hot reload keeps the room, world and identities`.

In **matches mode** (detected from `GET /gaime/room` → `mode`) clients join through `POST /gaime/room` like `GameClient`, and the steps change:

- A creates a private match and B joins it by the (lower-cased) invite code; `GET /gaime/room?code=` finds the same room. Prints `✓ private match <code>: create + join by invite code`. Steps 2–4 run in that match.
- Step 5 runs in a second private match (with 2 seats the first one is full).
- Public matchmaking: C and D are matchmade; they share a room (or a note says other players took the free seat). With `size: 2`, E must get a different room. A private match is never picked.
- Rooms of 1 seat: only a single-client welcome check.

It prints `PASS` on success. Any failed step throws (for example, `Timeout: B receives chat (stream patch)`), and the command exits 1. Each wait times out after 10 s unless stated otherwise.

### load

```sh
npm run load                                        # root: the game's own load script
npm run load -- --bots 50 --seconds 30              # starter (its script sets only --input)
npx gaime load --bots 50 --seconds 30 --rate 30 --input '{"mx":"$rand","mz":"$rand","fire":"$bool"}' --chat 0.5
npx gaime load https://game.example.com --bots 10   # remote target (no admin token needed)
```

This is a load and latency test with real WebSocket bots against a running game.

| Option | Default | Meaning |
| --- | --- | --- |
| `[url]` | `target().url` | The game to test. |
| `--bots <n>` | `20` | Number of bots (`bot-1` … `bot-n`), joined 50 ms apart. |
| `--seconds <n>` | `20` | Test duration, counted from the start. The ramp-up is included. |
| `--rate <n>` | `20` | Input messages per second per bot (only with an input template). |
| `--input '<json>'` | `$GAIME_LOAD_INPUT` | Input template (below). Without a template, bots send no input. |
| `--chat <p>` | `0` | Probability per bot per second of sending a `$chat` message (`ping <timestamp>`). |

Each bot joins with a random ticket and `ephemeral: true`, and has reconnection disabled. In matches mode every bot is matchmade through `POST /gaime/room` (bots fill rooms of `size`); the report adds `bots.rooms`, the number of rooms they ended up in. It pings every second, sends input at `--rate` per second and chats with probability `--chat` per second. The command samples `/gaime/stats` every 2 s and prints a progress line every 5 s:

```text
  15 s · online 50/50 · RTT p50 3.2 ms · p99 11.8 ms
```

#### Input template

The template is JSON. It is generated again for every message, and nested objects and arrays are walked. Strings that start with `$` are replaced:

| Token | Value |
| --- | --- |
| `"$rand"` | uniform number in -1..1 |
| `"$rand*N"` | uniform number in -N..N (`N` may be a decimal or negative), e.g. `"$rand*25"` |
| `"$bool"` | `true` or `false` |
| `"$int(a,b)"` | integer from `a` to `b` inclusive, e.g. `"$int(0,180)"` (a space after the comma is allowed) |
| `"$pick(a\|b\|c)"` | one of the options, as a string |

Other values, including unknown `$…` strings, are passed through unchanged. Invalid JSON aborts the command with the parse error. Put the template in single quotes in the shell so `$rand` is not expanded. Each game ships a matching template in its `load` script:

| Game | `load` script |
| --- | --- |
| blank | `gaime load --input '{"mx":"$rand","mz":"$rand"}'` |
| starter | `gaime load --input '{"mx":"$rand","mz":"$rand","ax":"$rand*25","az":"$rand*25","fire":"$bool"}'` |
| duel | `gaime load --bots 2 --input '{"move":"$rand","aim":"$int(0,180)"}'` |

The last occurrence of a flag wins, so `npm run load -- duel --bots 50` or `npm run load -- --input '…'` overrides the preset in the game's script.

#### Report

At the end the command prints a JSON report:

| Field | Meaning |
| --- | --- |
| `bots.requested`, `.joined`, `.failed`, `.dropped` | Bots asked for, joined, failed to join, and disconnected before the end. |
| `joinMs.p50`, `.p95` | Time to join the room, in ms. |
| `rttMs.p50`, `.p95`, `.p99`, `.max` | WebSocket ping round trip over all samples, in ms. |
| `perBot.messagesInPerSecond` | `welcome` and `patch` messages received per bot per second. |
| `perBot.approxKBInPerSecond` | Their JSON size per bot per second, in KB (approximate: the wire format is MessagePack). |
| `total.messagesOutPerSecond` | Inputs and chat messages sent by all bots per second (pings are not counted). |
| `total.approxKBInPerSecond` | Received JSON size for all bots per second, in KB. |
| `server.tickMsMax`, `.publishMsMax`, `.patchBytesMax` | Largest `max` of `tickMs`, `publishMs` and `patchBytes` over the `/gaime/stats` samples. |
| `server.eventLoopP99Max` | Largest event-loop delay p99, in ms. |
| `server.memoryMbMax` | Largest server memory, in MB. |
| `errors` | The first 10 join errors and disconnects. |

If `server.tickMsMax` exceeds the tick budget (`1000 / tickRate` ms, with the game's `tickRate` from `/gaime/stats`; 33.3 ms at the default 30 Hz), it prints a warning. The command exits 1 if any bot failed or dropped. The meaning of the server metrics is described in [SERVER.md](../SERVER.md#http), and tuning in [PROTOCOL.md](../PROTOCOL.md#latency-and-load-testing).

## Scaffolding

### new

```sh
npm run new-game -- super-popes --title "Popes vs Pops"            # from the repo root
npx gaime new arena-2 --from starter
npx gaime new --list
```

`gaime new <name>` creates `games/<name>` by copying a template game. The repository root is found with `git rev-parse --show-toplevel` (or the current directory if that fails), so it can run anywhere in the repo.

| Argument | Default | Meaning |
| --- | --- | --- |
| `<name>` | required | Matches `^[a-z][a-z0-9-]{1,40}$`: lowercase letters, digits and dashes, 2–41 characters, starting with a letter. |
| `--title "<title>"` | the name in Title Case (`super-popes` becomes `Super Popes`) | Visible title. |
| `--from <game>` | `blank` | Template: any directory in `games/` with a `package.json`. |
| `--list` | — | List the templates (name plus package `description`). |

The copy skips `node_modules`, `dist`, `.gaime` and `.devmode.json`. Then, in every `.ts`, `.mjs`, `.js`, `.json`, `.html`, `.md` and `.css` file:

- `'<from>'` becomes `'<name>'` (the game name in `defineGame` and `GameClient`);
- `"name": "<from>"` becomes `"name": "<name>"`;
- `games/<from>` becomes `games/<name>`.

In `.html` and `.ts` files, the template's `<title>` text becomes the new title where it appears as `>Title<` or `title: 'Title'`.

It prints the next steps:

```text
Created games/super-popes ("Popes vs Pops").

Next:
  npm install
  npm run dev -- super-popes

Then: git add games/super-popes package-lock.json && git commit && git push — and set up hosting (docs/DEPLOYMENT.md).
```

`gaime new` without a name, or `gaime new --list`, prints the templates and exits 0. With both a name and `--list`, it prints the list and then creates the game. Errors (exit 1): an invalid name, `No template games/<from>. Available: …`, and `games/<name> already exists.`

## npm scripts

### Root `package.json`

| Script | Command | What it does |
| --- | --- | --- |
| `dev` | `node scripts/game.mjs dev` | Vite dev server with Colyseus and HMR for one game (`npm run dev -- duel`). |
| `build` | `npm run build --workspaces --if-present` | Production build of **every** game (`vite build --app` → `dist/client`, `dist/server/server.mjs`). |
| `build:game` | `node scripts/game.mjs build` | Production build of one game (`npm run build:game -- duel`). |
| `host` | `node scripts/game.mjs host` | `gaime host` in one game's directory. |
| `smoke` | `node scripts/game.mjs smoke` | `gaime smoke` in one game's directory. |
| `load` | `node scripts/game.mjs load` | That game's `load` script (a `gaime load` with its input template). |
| `check` | `tsc --noEmit -p . && npm run check --workspaces --if-present` | Typechecks the framework (the root `tsconfig.json`: `packages/core/src`, `packages/core/tests`), then every game's `check`. |
| `test` | `vitest run` | Every test: `tests/`, `packages/*/tests/` and `games/*/tests/`. |
| `new-game` | `node packages/host/bin/gaime.mjs new` | [`gaime new`](#new) (`npm run new-game -- <name> --title "…"`). |
| `gaime` | `node packages/host/bin/gaime.mjs` | Any `gaime` command, run in the repo root (`npm run gaime -- new --list`). |
| `deploy` | `git push origin main` | Pushes `main`. A running supervisor picks the commit up within `GAIME_POLL_MS`. |

### `scripts/game.mjs`

```sh
npm run <script> [-- [<game>] [args…]]
```

This script runs `npm run <script> -w games/<game> [-- args…]` and exits with that command's status. It chooses the game as follows:

1. The first argument, if it names a directory in `games/` that contains a `package.json`. That argument is removed from the list.
2. Otherwise, `$GAIME_GAME`.
3. Otherwise, `starter` if it exists, or else the first game directory.

An unknown game (for example, a wrong `GAIME_GAME`) prints `No game "<name>". Available: …` and exits 1. The remaining arguments are passed to the game script:

```sh
npm run dev                          # starter
npm run dev -- duel                  # duel
GAIME_GAME=blank npm run smoke       # blank
npm run smoke -- duel --hmr          # gaime smoke --hmr in games/duel
npm run load -- --bots 50            # starter: gaime load --input '…' --bots 50
```

### Game `package.json` scripts

All three games (`blank`, `starter`, `duel`) define the same scripts, and you run them inside `games/<name>`:

| Script | Command | What it does |
| --- | --- | --- |
| `dev` | `vite` | Dev server on `GAIME_PORT` (default 5173) with the `gaime()` Vite plugin: client HMR, server HMR, feature discovery. |
| `build` | `vite build --app` | Client in `dist/client`, server in `dist/server/server.mjs` (plus workers). |
| `start` | `node dist/server/server.mjs` | Runs a production build (serves `dist/client` too). |
| `check` | `tsc --noEmit -p .` | Typechecks the game. This is the default live-mode deploy gate. |
| `test` | `vitest run --root ../.. games/<name>` | The game's tests with the root Vitest config. |
| `host` | `gaime host` | [host](#host) |
| `smoke` | `gaime smoke` | [smoke](#smoke) |
| `load` | `gaime load …` | [load](#load) with the game's input template |

## See also

- [../CLIENT.md](../CLIENT.md): browser side, network simulation `?lag=…&jitter=…&loss=…`
- [../SERVER.md](../SERVER.md): `GameDefinition.admin`, metrics, saves
- [../DEPLOYMENT.md](../DEPLOYMENT.md): supervisor modes, Docker, systemd, troubleshooting
- [../PROTOCOL.md](../PROTOCOL.md): messages, delta sync, latency and load testing
- [../ARCHITECTURE.md](../ARCHITECTURE.md): how hot reload and the supervisor fit together
- [CONFIG.md](CONFIG.md): every option and environment variable
