#!/usr/bin/env bash
# Rebuild and restart the app on the server without freezing it. Run on the
# server (update.sh and migrate.sh call it over ssh):
#
#   bash /opt/companion/deploy/build-on-server.sh [/opt/companion]
#
# A plain `docker compose up --build` once ran the 2 GB server out of memory
# with QQ (NapCat) running and froze it until a hard reboot. So: stop the app
# during the build (QQ keeps running, so the bot stays logged in), build at
# low priority with Node's heap capped (see Dockerfile / next.config.js), then
# start the new app.
set -euo pipefail

DIR="${1:-/opt/companion}"
cd "$DIR/deploy"

echo "==> Stopping the app for the build (QQ stays up)"
docker compose stop app
# If the build fails, bring the previous image back up.
trap 'echo "==> Build failed, restarting the previous version"; docker compose up -d --no-build app' ERR
echo "==> Building (low priority)"
# A stuck download once hung `npm ci` with the app down; give up instead.
timeout 30m nice -n 15 docker compose build app
echo "==> Starting the new app"
docker compose up -d --no-build app
docker compose ps
