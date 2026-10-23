#!/usr/bin/env bash
# One-time move from this Mac to a server: copies code, chat history/memories,
# settings and the NapCat login data, then starts everything there.
# Run on the Mac from anywhere:
#
#   deploy/migrate.sh root@SERVER_IP [/opt/companion]
#
# It stops the local NapCat first: the same QQ account logged in on two
# machines would keep kicking itself offline.
set -euo pipefail

TARGET="${1:?usage: deploy/migrate.sh root@SERVER_IP [remote_dir]}"
DIR="${2:-/opt/companion}"
cd "$(dirname "$0")/.."

for f in .env.local napcat/.env; do
  [ -f "$f" ] || { echo "missing $f"; exit 1; }
done

echo "==> Stopping local NapCat and app"
(cd napcat && docker compose stop) || true
lsof -tiTCP:3000 -sTCP:LISTEN | xargs kill 2>/dev/null || true

echo "==> Copying project, data and settings to $TARGET:$DIR"
ssh "$TARGET" "mkdir -p '$DIR'"
rsync -az \
  --exclude node_modules --exclude .next --exclude .git \
  ./ "$TARGET:$DIR/"

echo "==> Starting on the server"
ssh "$TARGET" bash -s -- "$DIR" <<'REMOTE'
set -euo pipefail
cd "$1"
cp napcat/.env deploy/.env
# On the server NapCat reaches the app by compose service name.
sed -i 's#http://host.docker.internal:3000/api/qq/webhook#http://app:3000/api/qq/webhook#' \
  napcat/data/config/onebot11*.json
cd deploy
docker compose up -d --build
docker compose ps
REMOTE

cat <<EOF

==> Done. Next:
  1. Open an SSH tunnel:  ssh -L 6099:127.0.0.1:6099 -L 3000:127.0.0.1:3000 $TARGET
  2. Visit http://127.0.0.1:6099/webui (token: WEBUI_TOKEN in napcat/.env).
     If the bot is not logged in automatically, scan the QR code with the bot's phone QQ.
  3. Send her a QQ message.
EOF
