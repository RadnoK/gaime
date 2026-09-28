---
name: gaime-deploy
description: Ship and operate gaime games — push to main, follow the deploy, read gaime status, roll back, redeploy, set up a new game on a VPS (Docker/Traefik/Caddy/systemd), change live/release mode, debug failed or stuck deploys. Use for anything about hosting, publishing, servers or "my change is not live".
---

# Deploying and operating

Reference: `docs/DEPLOYMENT.md`. A supervisor (`gaime host`) per game follows `origin/main` every 3 s: typecheck gate → sync + hot reload (live mode) or build + restart (release mode) → confirmation through `/health` → automatic revert if the new code does not start.

## Ship a change

```sh
npm run check && npm test
git add <your files> && git commit -m "…"
git pull --rebase origin main && git push origin main     # never --force
```

That is the whole deploy. Do not SSH, restart or copy files unless the user asks.

## Follow / diagnose (on the server, in the game's directory)

```sh
cd /srv/gaime/<game>
docker compose logs -f --tail=100 game
docker compose exec game node /app/packages/host/bin/gaime.mjs status      # version, paused, last failure, history
```

| Status says | Meaning / action |
| --- | --- |
| `failed … Gate: npm run check` | type error — reproduce with `npm run check`, fix, push |
| `server code failed to load: …` | the module threw on import (duplicate id, bad registry data) — fix, push |
| `code error: …` / game paused ⚠ | exception in the simulation — the message is in the game feed and `/health`; fix, push (the reload resumes the game) |
| `superseded` | a newer push arrived; fine |
| `UPDATES PAUSED` | someone ran rollback/pause — after the fix: `gaime resume` |
| no new history entry | the commit only touched other games (filtered), or fetch fails (deploy key) |

Controls (inside the container: `docker compose exec game node /app/packages/host/bin/gaime.mjs <cmd>`; locally: `npx gaime <cmd>` in the game directory): `rollback` (previous version, pauses updates; one step only — a second rollback is refused), `resume`, `pause`, `redeploy` (retry the newest commit), `restart` (restart the game process, keeps the checkpoint). Each waits for the supervisor's acknowledgement and prints `Done: <cmd>.`, `<cmd> failed: …` (exit 1), or `Requested … see gaime status` while a deploy is still running. For scripts: `gaime status --json` prints pure JSON.

## Put a game online (first time)

From zero, entirely in the terminal: follow `docs/DEPLOYMENT.md` → "From zero, in the terminal (Vultr)". What you need from the user, and nothing else:

1. A Vultr API key (`VULTR_API_KEY`; they create the account and the key once in the web UI — you cannot). Never write it to a file in the repo.
2. The game directory, the fork's git URL (SSH for private repos), the region closest to their players (`waw` for Poland; ask if unclear).
3. A domain, or agreement to use `<ip-with-dashes>.sslip.io` (fine for jams and tests; a public game should get its own domain).
4. `gh` logged in (`gh auth status`) so you can add the read-only deploy key yourself.

Then run steps 1–6 of that section: `vultr-cli` creates the SSH key, firewall (22/80/443) and a `vc2-2c-4gb` server with `--image docker`, and waits for its IP; then `scp deploy/install.sh`, `install.sh … --print-deploy-key` → `gh repo deploy-key add`, `install.sh … --mode live --proxy caddy`, and poll `https://<domain>/health`. Report the URL, the server id and IP, and how to tear it down. Creating a server costs money — confirm the plan and region with the user before step 4.

On a VPS the user already has (Ubuntu/Debian, root SSH): skip to step 5. Manually on the server:

```sh
sudo bash deploy/install.sh <game> <domain> git@github.com:org/repo.git --mode live --proxy traefik
#   --proxy caddy  (own HTTPS on 80/443)   --proxy none  (your proxy → 127.0.0.1:<port>)
#   --password     (shared password, login "player"; interactive)
#   --print-deploy-key  (only create and print the deploy key, then exit)
```

Several games per server are fine (separate directories/ports/domains). Without Docker: `deploy/systemd/gaime@.service` (see docs/DEPLOYMENT.md). On a laptop / Tailscale: `cd games/<game> && npx gaime host` (deploys local commits when there is no origin).

Latency: the server region matters most — one game runs on one server, so host near most players; keep the domain unproxied (Cloudflare "DNS only"). Game-side tuning is in the `gaime-networking` skill.

## Modes

- `GAIME_MODE=live` (default): Vite on the server, pushes hot-reload in ~3 s without disconnecting anyone. Best for jams and fast iteration.
- `GAIME_MODE=release`: production builds, ~4 s restart, nginx keeps pages up. Best for a stable public game.
- Switch: edit `/srv/gaime/<game>/.env`, `docker compose up -d game`.

## Things that need a manual step

- Changes to `packages/host` (the supervisor itself): `docker compose restart game`.
- Changes to `deploy/docker/*`: re-run `install.sh` (idempotent) or copy the file and `docker compose up -d`.
- Restoring an old save: stop the game, copy a file from `backups/` or `repo/.gaime/<game>/snapshots/` to `data/checkpoint.json`, start it.

## Pitfalls

- Never `git reset` inside `/srv/gaime/<game>/repo` or edit `.gaime/` by hand.
- Never delete `data/` (saves, admin token).
- A dependency change (lockfile) means `npm ci` + a restart for everyone instead of a hot reload — batch them.
- Load tests against the public game disturb real players — ask first.

## Reference

`docs/DEPLOYMENT.md`, `docs/reference/CLI.md` (host, status, rollback, resume, redeploy), `docs/reference/CONFIG.md` (environment variables).
