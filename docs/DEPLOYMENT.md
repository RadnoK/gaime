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

## From zero, in the terminal (Vultr)

For a fork that should go online without clicking through a control panel. The whole setup is CLI commands an AI agent can run; a person only creates the account and one API key.

**Why Vultr:** a Warsaw data centre (plus 9 US regions, Tokyo, Seoul, Singapore, India…), an official CLI that covers SSH keys, firewalls and servers, a Docker image, IPv4 included, hourly billing. A 2 vCPU / 4 GB server (`vc2-2c-4gb`) is about $20/month and holds a game with dozens of players; a dedicated vCPU (`voc-c-2c-4gb`, ~$40) removes tick jitter from noisy neighbours. Any other VPS works the same from step 5 on (see [other providers](#other-providers)).

**Pick the region closest to most players** — it is the biggest part of the latency ([PROTOCOL.md → Latency budget](PROTOCOL.md#latency-budget)): `waw` Warsaw, `fra` Frankfurt, `ams` Amsterdam, `lhr` London, `ewr` New Jersey, `ord` Chicago, `lax` Los Angeles, `nrt` Tokyo, `sgp` Singapore (`vultr-cli regions list` for all).

```sh
# 0. Once, by a person: create an account at vultr.com, then Account → API → Enable API
#    (allow all IPv4) and hand the key to the agent. Never commit it.
export VULTR_API_KEY=…

# 1. Tools on your machine (Linux: the release binary from github.com/vultr/vultr-cli)
brew install vultr/vultr-cli/vultr-cli jq gh

# 2. An SSH key for the server
[ -f ~/.ssh/gaime ] || ssh-keygen -q -t ed25519 -N '' -f ~/.ssh/gaime
KEY=$(vultr-cli ssh-key create --name gaime --key "$(cat ~/.ssh/gaime.pub)" -o json | jq -r '.ssh_key.id')

# 3. A firewall: only SSH and HTTP(S)
FW=$(vultr-cli firewall group create --description gaime -o json | jq -r '.firewall_group.id')
for port in 22 80 443; do vultr-cli firewall rule create "$FW" --protocol tcp --port $port --ip-type v4 --subnet 0.0.0.0 --size 0; done

# 4. The server, and its address once it has one
ID=$(vultr-cli instance create --region waw --plan vc2-2c-4gb --image docker --ssh-keys "$KEY" \
     --firewall-group "$FW" --label gaime -o json | jq -r '.instance.id')
until IP=$(vultr-cli instance get "$ID" -o json | jq -r '.instance.main_ip') && [ "${IP:-0.0.0.0}" != 0.0.0.0 ] && [ "$IP" != null ]; do sleep 5; done

# 5. Install the game (any Ubuntu/Debian VPS with root SSH works from here)
GAME=starter                                  # a directory in games/
REPO=git@github.com:you/your-fork.git
DOMAIN=${IP//./-}.sslip.io                    # or your own domain with an A record → $IP
SSH_OPTS="-i $HOME/.ssh/gaime -o StrictHostKeyChecking=accept-new"
until ssh $SSH_OPTS root@$IP true 2>/dev/null; do sleep 5; done
scp $SSH_OPTS deploy/install.sh root@$IP:install.sh
ssh $SSH_OPTS root@$IP 'docker compose version >/dev/null 2>&1 || curl -fsSL https://get.docker.com | sh'
ssh $SSH_OPTS root@$IP "bash install.sh $GAME $DOMAIN $REPO --print-deploy-key" > /tmp/gaime-deploy-key.pub
gh repo deploy-key add /tmp/gaime-deploy-key.pub --repo you/your-fork --title "gaime $GAME $IP"   # read-only
ssh $SSH_OPTS root@$IP "bash install.sh $GAME $DOMAIN $REPO --mode live --proxy caddy"

# 6. Wait until it answers (the first start runs npm ci and gets a certificate: a few minutes)
until curl -fsS "https://$DOMAIN/health"; do sleep 10; done
```

From now on `git push origin main` is the deploy. Operations are in [the next section](#operations).

The `-o json` output of `vultr-cli` is the source of truth: if a `jq` path prints `null`, read the JSON and use the field that holds the id or address. The commands are idempotent enough to re-run: `install.sh` keeps the key, the clone and `.env`; for a second server create a new instance (step 4 on).

**Without a domain.** `<ip-with-dashes>.sslip.io` resolves to the server, so Caddy gets a real Let's Encrypt certificate without buying anything — good for jams and trying things. It shares one certificate rate limit with every sslip.io user in the world, so a public game should get its own domain: add an A record for it pointing at `$IP` at your registrar, set `DOMAIN` in `/srv/gaime/<game>/.env`, then `docker compose up -d`. Keep the domain "DNS only" (not proxied) on Cloudflare.

**Public forks** can use an HTTPS URL (`https://github.com/you/your-fork.git`) and skip the deploy key; private ones need the SSH URL and the key. `gh repo deploy-key add` ties the key to your `gh` login: it disappears if you revoke the GitHub CLI app.

**Tearing down:** `vultr-cli instance delete "$ID"` (billing stops; the checkpoint goes with the disk — copy `/srv/gaime/<game>/data/checkpoint.json` first if you want to keep the world), then `gh repo deploy-key list` / `delete`.

### Other providers

Steps 5–6 are the same on any VPS with Docker (or plain Ubuntu: the command above installs Docker). Only steps 2–4 change:

| Provider | CLI | Closest to Poland | Notes |
| --- | --- | --- | --- |
| Hetzner Cloud | `hcloud` (`server create --image docker-ce`, `firewall`, `zone`) | Falkenstein / Nuremberg (~20 ms) | the cheapest and the smoothest CLI; in 2026 new customers were temporarily unable to create servers — check before recommending it |
| Linode / Akamai | `linode-cli` (logs in through the browser — no key to copy) | Frankfurt (~25 ms) | broad US/Asia coverage |
| DigitalOcean | `doctl` | Frankfurt (~25 ms) | |
| Scaleway | `scw` (`scw login` in the browser) | Warsaw | EU only; IPv4 costs extra |

Serverless and scale-to-zero platforms (Vercel, Cloudflare Workers, Lambda, free Render/Railway tiers) do not fit: a game is one long-running process with open WebSockets, a world in memory and a checkpoint on disk.

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

- **Rollback** in live mode reverts the code (the world stays — HMR); in release mode it reverts the code **and** the matching checkpoint (progress since that deploy is lost). After a rollback updates stay paused until `resume`; the bad commit does not come back by itself — push a fix or `git revert`. There is only one step back: a second `rollback` is refused until a new version has been deployed. Control commands wait for the supervisor and print `Done`, the failure (exit code 1), or `Requested — … see gaime status` when it is still busy with a deploy.
- **Supervisor code changes** (`packages/host`) need `docker compose restart game` (the supervisor logs a reminder). Changes to `deploy/docker/*` → run `install.sh` again (it is idempotent) or copy the files by hand and `docker compose up -d`.
- **Switching modes**: `GAIME_MODE` in `.env` and `docker compose up -d game`.
- **Other settings**: only variables listed in `compose.yml` reach the container; every optional one (`GAIME_REMOTE`, `GAIME_SOAK_MS`, `GAIME_START_TIMEOUT_MS`, `GAIME_HMR_TIMEOUT_MS`, `GAIME_SERVER_ENTRY`, `GAIME_ALLOWED_HOSTS`, `GAIME_LATENCY_MS`) is listed, commented out, in `deploy/docker/env.example` — empty means the default. `GAIME_PORT` (5173) and `GAIME_PUBLIC_DIR` (`/app/.gaime/<GAME>/public`) are fixed because the health check and the gateway depend on them.
- Never `git reset` inside `repo/` and never edit `.gaime/` by hand. Do not delete `data/`.

## Scaling out

A game with `rooms: { mode: 'matches' }` ([ROOMS.md](ROOMS.md)) can run its matches in several processes that share them through Redis. A shared game is one room: it always runs in one process (extra processes stay idle and say so in the log).

On a Docker server, in `/srv/gaime/<game>/.env`:

```sh
GAIME_MODE=release                                            # live mode runs one Vite dev server: GAIME_PROCESSES > 1 is refused
GAIME_PROCESSES=4                                             # at most 16
COMPOSE_FILE=compose.yml:compose.traefik.yml:compose.redis.yml   # or with compose.caddy.yml
```

then `docker compose up -d` (a new install: `install.sh … --mode release --processes 4`). `compose.redis.yml` adds a `redis` service (in memory only — the room listing needs no backup) and passes `GAIME_REDIS_URL=redis://redis:6379` and `GAIME_PROCESSES` to the game container.

What happens:

- The supervisor builds each release once and starts `GAIME_PROCESSES` processes of it on consecutive ports (`GAIME_PORT`, `+1`, …), each with `GAIME_PROCESS_INDEX`, the same `GAIME_REDIS_URL` and `GAIME_PUBLIC_ADDRESS=<host of GAIME_PUBLIC_URL>/p<i>` (without a public URL: `127.0.0.1:<port>`). Their output is prefixed `[p<i>]`.
- The gateway serves the page and routes the plain paths (`/gaime/room`, Colyseus matchmaking, reconnection) to process 0 and `/p<i>/<process>/<room>` WebSockets to process i. Nothing else of the other processes is public.
- A deploy is confirmed when **every** process reports the new version on its `/health` and still does after the soak; otherwise every process goes back to the previous release. `rollback` and `restart` handle all processes; a process that crashes is restarted alone (with backoff) — the others keep their matches.
- `gaime status` shows each process (`p0:5173 ok <version> 3 rooms   p1:5174 …`); `gaime rooms` lists the rooms of all of them.
- Every deploy restarts the processes, which ends their matches (matches are not saved). Players reconnect and are matchmade again.

Without Docker: set `GAIME_MODE=release`, `GAIME_PROCESSES`, `GAIME_REDIS_URL` and `GAIME_PUBLIC_URL` for `gaime host`, and route `/p<i>/` to port `GAIME_PORT + i` in your proxy (see `deploy/docker/gateway.conf`). Several machines work the same way — one Redis, and a `GAIME_PUBLIC_ADDRESS` per process that reaches it.

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
| `GAIME_PORT` | `5173` | game port (HTTP + WebSocket); a production build also accepts `PORT` |
| `GAIME_BRANCH`, `GAIME_REMOTE` | `main`, `origin` | what to follow; without a remote — the local HEAD |
| `GAIME_POLL_MS` | `3000` | `git fetch` interval (minimum 100) |
| `GAIME_GATES` | `auto` | gates before a deploy |
| `GAIME_DATA_DIR` | `.gaime/<game>/data` (under the supervisor; a plain game server: `.gaime/data` in the game directory) | checkpoint and admin token |
| `GAIME_STATE_DIR` | `.gaime/<game>` | releases, live tree, snapshots, state |
| `GAIME_PUBLIC_DIR` | `.gaime/<game>/public` | files published for the gateway (release) |
| `GAIME_PUBLIC_URL` | — | public address (HMR over `wss` behind a proxy, `allowedHosts`) |
| `GAIME_ALLOWED_HOSTS` | — | extra host names for Vite (Tailscale DNS) |
| `GAIME_ADMIN_TOKEN` | file in data | admin API token |
| `GAIME_LATENCY_MS` | — | simulated server round trip (testing) |
| `GAIME_START_TIMEOUT_MS`, `GAIME_HMR_TIMEOUT_MS`, `GAIME_SOAK_MS` | 120 000 / 30 000 / 2 500 | version confirmation timing (timeouts: minimum 1000) |
| `GAIME_SERVER_ENTRY` | `src/server/index.ts` | server entry the live supervisor touches after a sync |
| `GAIME_PROCESSES` | `1` | game processes (release mode, matches mode, with `GAIME_REDIS_URL`) — [Scaling out](#scaling-out) |
| `GAIME_REDIS_URL` | — | Redis shared by the processes of a matches game (production builds) |
| `GAIME_PUBLIC_ADDRESS` | set by the supervisor | where clients reach one process's rooms: `host[:port][/path]` |
| `GAIME_EMPTY_ROOM_SECONDS`, `GAIME_MAX_ROOMS` | 30 / 1000 | matches mode: an empty room closes after this long; the most rooms at once |

A numeric setting that is not a number or is below its minimum falls back to the default, with a warning in the supervisor log.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| a push does not arrive | `gaime status` (paused? failed?), the `game` logs, the deploy key (`git fetch` inside the container) |
| `failed … gate` | run `npm run check` locally; fix and push |
| `server code failed to load` | an error while importing a module (e.g. a duplicate id) — the full message is in the log |
| game paused with ⚠ | an exception in `step`; the message is in the feed and in `/health`; a fix resumes the game |
| `Corrupt checkpoint` | the file is kept — restore a copy from `backups/` or `snapshots/` while the game is stopped |
| the browser gets no HMR behind a proxy | `GAIME_PUBLIC_URL` must be exactly the public address (https → wss:443) |
