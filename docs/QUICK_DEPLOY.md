# Put a game online with a team

This is the shortest path for **one game on one VPS**. You set up GitHub and the server once. After that, a push to `main` deploys the game automatically. Use [the full deployment guide](DEPLOYMENT.md) for other proxies, multiple games on one server, release mode, and rollback details.

## Before you start

- A GitHub repository containing this project, with a `main` branch. Choose a directory under `games/`, such as `starter` or your own game. You need repository owner/admin access to invite people and, for a private repository, add a deploy key.
- An Ubuntu or Debian VPS with a public IPv4 address, root SSH access, Docker and Docker Compose v2. A provider's Docker image is the easiest starting point. Open inbound TCP ports **22, 80 and 443** in its firewall; reserve 80 and 443 for this game's Caddy proxy. Add your SSH public key when creating the VPS so `ssh root@SERVER_IP` works. The installer also needs `git`, `ssh-keygen` and `ssh-keyscan`; the command below installs them.
- A domain with an **A record** pointing to the VPS IP. For a trial, use `<IP-with-dashes>.sslip.io` instead (for example, `203-0-113-10.sslip.io` for `203.0.113.10`); no DNS setup is needed. Use your own domain for a public game.

If you still need a VPS, [the Vultr recipe](DEPLOYMENT.md#from-zero-in-the-terminal-vultr) creates one from the terminal. Creating a server starts hosting charges.

## 1. Invite the team

In your GitHub repository, open **Settings → Collaborators → Add people**, enter each GitHub username, and send the invitation. Each person must accept it before they can push. For an organization repository, use **Settings → Collaborators & teams → Add people** and grant **Write** access. [GitHub's personal-repository instructions](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/repository-access-and-collaboration/inviting-collaborators-to-a-personal-repository) and [organization instructions](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/managing-repository-settings/managing-teams-and-people-with-access-to-your-repository) show the current screens.

The server does **not** need a collaborator account. For a public repository it can clone over HTTPS; a private repository uses a read-only deploy key in step 2.

## 2. Install the game on the VPS

From a local checkout of the repository, replace the example IP, game and `OWNER/REPO` with your values, then run this block from the repository root. For your own domain, uncomment and edit the `DOMAIN=game.example.com` line; otherwise keep the generated `sslip.io` address.

```sh
SERVER_IP=203.0.113.10
GAME=starter
REPO_URL=https://github.com/OWNER/REPO.git
DOMAIN="$(printf '%s' "$SERVER_IP" | tr . -).sslip.io"
# DOMAIN=game.example.com

ssh "root@$SERVER_IP" 'docker compose version && apt-get update && apt-get install -y git openssh-client'
scp deploy/install.sh "root@$SERVER_IP:/root/gaime-install.sh"
ssh -tt "root@$SERVER_IP" "bash /root/gaime-install.sh '$GAME' '$DOMAIN' '$REPO_URL' --mode live --proxy caddy"
```

For a **private** repository, replace the `REPO_URL=` line in the block with `REPO_URL=git@github.com:OWNER/REPO.git`, using your repository path. The installer prints a **public** SSH key and waits. In GitHub, open **Settings → Deploy keys → Add deploy key**, paste that key, and leave **Allow write access** unchecked. Return to the terminal and press Enter. Do not paste the private key. [GitHub's deploy-key instructions](https://docs.github.com/en/authentication/connecting-to-github-with-ssh/managing-deploy-keys).

If setup stops before you add the private repository's key, print the same public key again with `ssh "root@$SERVER_IP" "bash /root/gaime-install.sh '$GAME' '$DOMAIN' '$REPO_URL' --print-deploy-key"`. Add it in GitHub, then rerun the main install command.

The installer creates `/srv/gaime/<game>/`, clones the repository, writes `.env`, starts the game and HTTPS proxy, and enables hourly checkpoint backups on a systemd host. It is safe to rerun if setup stops partway through. The first start can take a few minutes while dependencies install and the HTTPS certificate is issued.

## 3. Check the result

Open `https://<your-domain>/` in a browser. The health endpoint should return JSON with `"ok":true`:

```sh
curl -fsS "https://$DOMAIN/health"
ssh "root@$SERVER_IP" "cd /srv/gaime/$GAME && docker compose exec -T game node /app/packages/host/bin/gaime.mjs status"
```

If it is still starting, check `ssh "root@$SERVER_IP" "cd /srv/gaime/$GAME && docker compose logs --tail=100 game"`. A failed deploy is also shown by `status`; see [troubleshooting](DEPLOYMENT.md#troubleshooting).

## Every later deploy

Each contributor works in their own checkout. Run both checks first:

```sh
npm run check && npm test
```

Only if they pass, replace `path/to/your/changed/file` with the paths you actually changed, then publish:

```sh
git add path/to/your/changed/file
git commit -m "Describe the change"
git pull --rebase origin main
git push origin main
```

The game server polls `main` every three seconds, checks the candidate, and hot-reloads it in live mode. A candidate that fails to start is reverted automatically. GitHub Actions runs checks too, but **Actions does not deploy**; no GitHub Actions secret is needed for this setup.

For server settings, edit `/srv/gaime/<game>/.env` and run `docker compose up -d` in that directory. See [environment variables](DEPLOYMENT.md#environment-variables). To host a second game on the same VPS, use a shared proxy: a second `--proxy caddy` install would try to bind the same ports 80 and 443.
