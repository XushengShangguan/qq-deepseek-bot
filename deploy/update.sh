#!/usr/bin/env bash
# Push code / persona changes from this Mac to the server and rebuild the app.
# Leaves the server's data, settings and NapCat login untouched.
#
#   deploy/update.sh root@SERVER_IP [/opt/companion]
set -euo pipefail

TARGET="${1:?usage: deploy/update.sh root@SERVER_IP [remote_dir]}"
DIR="${2:-/opt/companion}"
cd "$(dirname "$0")/.."

rsync -az \
  --exclude node_modules --exclude .next --exclude .git \
  --exclude /data/ --exclude /napcat/ --exclude /deploy/.env \
  --exclude .env.local \
  ./ "$TARGET:$DIR/"

ssh "$TARGET" "cd '$DIR/deploy' && docker compose up -d --build app && docker compose ps"
