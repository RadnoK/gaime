#!/usr/bin/env bash
# Put one game on a server (Docker). Idempotent: re-run to update compose/gateway files.
#
#   curl -fsSL https://raw.githubusercontent.com/<org>/<repo>/main/deploy/install.sh -o install.sh
#   sudo bash install.sh <game> <domain> <git-url> [--mode live|release] [--proxy traefik|caddy|none]
#                        [--password] [--dir /srv/gaime] [--branch main]
#
# Afterwards every push to the branch reaches the players automatically.
set -euo pipefail

usage() { sed -n '2,10p' "$0"; exit 1; }
[[ $# -ge 3 ]] || usage
GAME=$1; DOMAIN=$2; REPO_URL=$3; shift 3
MODE=live; PROXY=traefik; PASSWORD=0; BASE_DIR=/srv/gaime; BRANCH=main
while [[ $# -gt 0 ]]; do
  case $1 in
    --mode) MODE=$2; shift 2 ;;
    --proxy) PROXY=$2; shift 2 ;;
    --password) PASSWORD=1; shift ;;
    --dir) BASE_DIR=$2; shift 2 ;;
    --branch) BRANCH=$2; shift 2 ;;
    *) usage ;;
  esac
done
[[ $GAME =~ ^[a-z][a-z0-9-]+$ ]] || { echo "Game name: lowercase letters, digits, dashes."; exit 1; }
[[ $MODE == live || $MODE == release ]] || { echo "--mode live|release"; exit 1; }
for tool in docker git ssh-keygen ssh-keyscan; do command -v "$tool" >/dev/null || { echo "Missing: $tool"; exit 1; }; done
docker compose version >/dev/null || { echo "Missing docker compose v2"; exit 1; }

BASE="$BASE_DIR/$GAME"
echo "▶ $GAME → https://$DOMAIN  (mode $MODE, proxy $PROXY, directory $BASE)"
mkdir -p "$BASE"/{data,ssh,auth,backups}

# ── read-only deploy key ──────────────────────────────────────────────
if [[ $REPO_URL == git@* || $REPO_URL == ssh://* ]]; then
  if [[ ! -f $BASE/ssh/deploy-key ]]; then
    ssh-keygen -q -t ed25519 -N '' -C "gaime-$GAME@$(hostname)" -f "$BASE/ssh/deploy-key"
    echo
    echo "Add this key as a read-only Deploy key of the repository (GitHub → Settings → Deploy keys):"
    echo
    cat "$BASE/ssh/deploy-key.pub"
    echo
    if [[ -t 0 ]]; then read -r -p "Press Enter once the key is added… "; fi
  fi
  HOST=$(sed -E 's#^(ssh://)?([^@]+@)?([^:/]+).*#\3#' <<<"$REPO_URL")
  [[ -s $BASE/ssh/known_hosts ]] || ssh-keyscan -t ed25519,rsa "$HOST" > "$BASE/ssh/known_hosts" 2>/dev/null
  export GIT_SSH_COMMAND="ssh -i $BASE/ssh/deploy-key -o UserKnownHostsFile=$BASE/ssh/known_hosts -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes"
fi
chmod 700 "$BASE/ssh"; chmod 600 "$BASE"/ssh/* 2>/dev/null || true

# ── repository clone (the supervisor only fetches; it never touches the working tree) ──
if [[ ! -d $BASE/repo/.git ]]; then
  git clone --branch "$BRANCH" "$REPO_URL" "$BASE/repo"
else
  git -C "$BASE/repo" fetch origin "$BRANCH" && git -C "$BASE/repo" merge --ff-only "origin/$BRANCH" || echo "(repo: working tree not updated)"
fi
[[ -d $BASE/repo/games/$GAME ]] || { echo "The repository has no games/$GAME"; exit 1; }
mkdir -p "$BASE/repo/.gaime/$GAME/public"

# ── compose + gateway ─────────────────────────────────────────────────
for file in compose.yml compose.traefik.yml compose.caddy.yml Caddyfile gateway.conf; do cp "$BASE/repo/deploy/docker/$file" "$BASE/$file"; done
case $PROXY in
  traefik) COMPOSE_FILE=compose.yml:compose.traefik.yml ;;
  caddy) COMPOSE_FILE=compose.yml:compose.caddy.yml ;;
  none) COMPOSE_FILE=compose.yml ;;
  *) echo "--proxy traefik|caddy|none"; exit 1 ;;
esac
if [[ ! -f $BASE/.env ]]; then
  # Each game on the host gets its own local gateway port.
  PORT=8080; while grep -qs "GATEWAY_BIND=127.0.0.1:$PORT" "$BASE_DIR"/*/.env; do PORT=$((PORT + 1)); done
  sed -e "s/^GAME=.*/GAME=$GAME/" -e "s/^DOMAIN=.*/DOMAIN=$DOMAIN/" -e "s/^GAIME_MODE=.*/GAIME_MODE=$MODE/" \
      -e "s/^GAIME_BRANCH=.*/GAIME_BRANCH=$BRANCH/" -e "s#^COMPOSE_FILE=compose.yml:compose.traefik.yml#COMPOSE_FILE=$COMPOSE_FILE#" \
      -e "s/^GATEWAY_BIND=.*/GATEWAY_BIND=127.0.0.1:$PORT/" "$BASE/repo/deploy/docker/env.example" > "$BASE/.env"
  echo "Wrote $BASE/.env (local gateway port: $PORT)"
fi

# ── optional shared password (HTTP basic auth, login "player") ────────
if [[ $PASSWORD == 1 ]]; then
  read -r -s -p "Password for players (login: player): " SECRET; echo
  docker run --rm httpd:2-alpine htpasswd -nbB player "$SECRET" > "$BASE/auth/htpasswd"
  printf 'auth_basic "Game";\nauth_basic_user_file /etc/nginx/auth/htpasswd;\n' > "$BASE/auth/auth.conf"
fi
chmod 755 "$BASE/auth"; chmod 644 "$BASE"/auth/* 2>/dev/null || true

# The game container runs as 1000:1000.
chown -R 1000:1000 "$BASE/repo" "$BASE/data" "$BASE/ssh" 2>/dev/null || sudo chown -R 1000:1000 "$BASE/repo" "$BASE/data" "$BASE/ssh"

# ── hourly checkpoint backups (systemd) ───────────────────────────────
if command -v systemctl >/dev/null && [[ -d /etc/systemd/system ]]; then
  install -m 755 "$BASE/repo/deploy/backup.sh" "$BASE_DIR/backup.sh"
  sed "s#/srv/gaime#$BASE_DIR#g" "$BASE/repo/deploy/systemd/gaime-backup@.service" > /etc/systemd/system/gaime-backup@.service
  cp "$BASE/repo/deploy/systemd/gaime-backup@.timer" /etc/systemd/system/gaime-backup@.timer
  systemctl daemon-reload && systemctl enable --now "gaime-backup@$GAME.timer" >/dev/null && echo "Hourly checkpoint backups: $BASE/backups"
fi

(cd "$BASE" && docker compose up -d)
echo
echo "✅ Done.   Logs:   cd $BASE && docker compose logs -f game"
echo "   Status:         cd $BASE && docker compose exec game node /app/packages/host/bin/gaime.mjs status"
echo "   Game:           https://$DOMAIN"
