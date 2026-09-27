# Deploys, hot updates, rollback

Every game has one **supervisor** (`gaime host`, code in `packages/host`). Every `GAIME_POLL_MS` (3 s) the supervisor runs `git fetch` for `main` and deploys each new commit. The author's machine takes no part in a deploy: `git push` is enough.

## Modes

| | **live** (default) | **release** |
| --- | --- | --- |
| What runs on the server | Vite + Colyseus from the tree `.gaime/<game>/live` | `node dist/server/server.mjs` from an isolated release `.gaime/<game>/releases/<time>-<sha>` |
| A commit without new dependencies | typecheck the candidate → sync files → client and server HMR, **no restart** (~3 s) | `npm run build` next to the running game → short restart (~4 s) |
| New dependencies / Vite config | `npm ci` next to the running game → restart | `npm ci` once per dependency set (shared store) |
| Browsers | Vite HMR (the connection stays) | `watchVersion` → page reload, straight back into the game |
| When | workshops, game jams, fast iteration with AI | a stable public game, minified bundle |

Common to both:

- **Gates** (`GAIME_GATES`): `auto` = typecheck in live mode (it swaps code inside a running game), none in release mode (the build is the gate); `none`; or a list of npm scripts, e.g. `check,test`.
- **Confirmation**: the new code must report itself on `/health` with its own version and no error, and still be healthy 2.5 s later.
- **Automatic revert**: a commit that fails a gate, does not build, does not load (e.g. a duplicate module id), or pauses the game with an error right after start → the previous version comes back (live: sync of the previous tree; release: the previous release + its checkpoint). The game keeps running and the commit is marked as failed; the next push tries again.
- **Superseded commits**: if a newer push arrives while a candidate is being prepared, the older candidate is skipped.
- **Game filter**: a commit that only changes other games under `games/` does not redeploy this one.
- **Checkpoint snapshot** before every deploy (`.gaime/<game>/snapshots`).
- **Process crash** → restart with backoff (1 s … 30 s), state from the last checkpoint.

## Locally / on a laptop / over Tailscale

```sh
cd games/starter
npx gaime host                        # port 5173; without an origin it deploys local commits (HEAD)
npx gaime status
```

The supervisor runs **committed code only** (git archive) and never touches the working tree. For participants on Tailscale share `http://<tailscale-ip>:5173`; with a DNS name set `GAIME_ALLOWED_HOSTS=name.tailnet.ts.net`. Settings can live in `games/<game>/.env` or in `.env` at the repo root (read by the supervisor).

## A VPS with Docker (recommended)

Once, on a server with Docker and a domain pointing at it:

```sh
git clone <repo> /tmp/gaime && sudo bash /tmp/gaime/deploy/install.sh starter game.example.com git@github.com:org/repo.git \
  --mode live --proxy traefik        # or --proxy caddy (own HTTPS) / none (your own proxy on 127.0.0.1:8080)
  # --password                       # shared password for players (login: player)
```

The script creates `/srv/gaime/<game>/`, generates a deploy key (it prints it — add it as a **read-only Deploy key** of the repository), clones the repo, writes `.env`, copies the Compose and gateway files, sets up hourly checkpoint backups (systemd) and runs `docker compose up -d`.

```text
/srv/gaime/<game>/
  .env                 settings (deploy/docker/env.example)
  compose*.yml         copies from repo/deploy/docker
  gateway.conf         nginx configuration (the gateway)
  Caddyfile            for --proxy caddy
  repo/                clone of the repository; the supervisor only fetches
    .gaime/<game>/     live/ releases/ public/ snapshots/ host.json
  data/                checkpoint.json, admin-token
  ssh/                 deploy-key, known_hosts
  auth/                optional password (auth.conf, htpasswd)
  backups/             hourly checkpoints, kept 3 days
```

Containers: **game** (`node:24-bookworm`, UID 1000, runs the supervisor from `repo/`) and **gateway** (nginx: keeps the page up while the game restarts, proxies WebSockets and HMR, answers 503 + `Retry-After` while the game starts, blocks `/gaime/admin` from outside). With `compose.traefik.yml` the gateway joins the `edge` network of an existing Traefik; with `compose.caddy.yml` a dedicated Caddy serves HTTPS on 80/443.

Several games on one server: each has its own directory, Compose project (`gaime-<game>`), supervisor and domain; `install.sh` assigns consecutive local gateway ports.

### Operations

```sh
cd /srv/gaime/starter
docker compose logs -f --tail=100 game
docker compose exec game node /app/packages/host/bin/gaime.mjs status
docker compose exec game node /app/packages/host/bin/gaime.mjs rollback   # previous version + pause updates
docker compose exec game node /app/packages/host/bin/gaime.mjs resume     # after pushing a fix
docker compose exec game node /app/packages/host/bin/gaime.mjs redeploy   # retry the newest commit
docker compose exec game node /app/packages/host/bin/gaime.mjs players    # and the other admin commands (docs/SERVER.md)
```

- **Rollback** in live mode reverts the code (the world stays — HMR); in release mode it reverts the code **and** the matching checkpoint (progress since that deploy is lost). After a rollback updates stay paused until `resume`; the bad commit does not come back by itself — push a fix or `git revert`.
- **Supervisor code changes** (`packages/host`) need `docker compose restart game` (the supervisor logs a reminder). Changes to `deploy/docker/*` → run `install.sh` again (it is idempotent) or copy the files by hand and `docker compose up -d`.
- **Switching modes**: `GAIME_MODE` in `.env` and `docker compose up -d game`.
- Never `git reset` inside `repo/` and never edit `.gaime/` by hand. Do not delete `data/`.

## A VPS without Docker (systemd)

Node ≥ 22.12 and git on the server, a `gaime` user, a clone in `/srv/gaime/<game>/repo`, and `.env` with `GAIME_MODE`, `GAIME_PORT` (different for every game) and `GAIME_PUBLIC_URL=https://domain`.

```sh
sudo cp deploy/systemd/gaime@.service /etc/systemd/system/
sudo systemctl enable --now gaime@starter
journalctl -u gaime@starter -f
```

Put a reverse proxy with WebSockets in front of it (Caddy: `domain { reverse_proxy 127.0.0.1:5173 }`). In release mode without the nginx gateway the page is unavailable for the ~4 s of a restart — clients still come back by themselves.

## Environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `GAIME_MODE` | `live` | `live` / `release` |
| `GAIME_PORT` | `5173` | game port (HTTP + WebSocket) |
| `GAIME_BRANCH`, `GAIME_REMOTE` | `main`, `origin` | what to follow; without a remote — the local HEAD |
| `GAIME_POLL_MS` | `3000` | `git fetch` interval |
| `GAIME_GATES` | `auto` | gates before a deploy |
| `GAIME_DATA_DIR` | `.gaime/<game>/data` | checkpoint and admin token |
| `GAIME_STATE_DIR` | `.gaime/<game>` | releases, live tree, snapshots, state |
| `GAIME_PUBLIC_DIR` | `.gaime/<game>/public` | files published for the gateway (release) |
| `GAIME_PUBLIC_URL` | — | public address (HMR over `wss` behind a proxy, `allowedHosts`) |
| `GAIME_ALLOWED_HOSTS` | — | extra host names for Vite (Tailscale DNS) |
| `GAIME_ADMIN_TOKEN` | file in data | admin API token |
| `GAIME_LATENCY_MS` | — | simulated server round trip (testing) |
| `GAIME_START_TIMEOUT_MS`, `GAIME_HMR_TIMEOUT_MS`, `GAIME_SOAK_MS` | 120 000 / 30 000 / 2 500 | version confirmation timing |

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| a push does not arrive | `gaime status` (paused? failed?), the `game` logs, the deploy key (`git fetch` inside the container) |
| `failed … gate` | run `npm run check` locally; fix and push |
| `server code failed to load` | an error while importing a module (e.g. a duplicate id) — the full message is in the log |
| game paused with ⚠ | an exception in `step`; the message is in the feed and in `/health`; a fix resumes the game |
| `Corrupt checkpoint` | the file is kept — restore a copy from `backups/` or `snapshots/` while the game is stopped |
| the browser gets no HMR behind a proxy | `GAIME_PUBLIC_URL` must be exactly the public address (https → wss:443) |
