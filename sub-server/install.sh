#!/usr/bin/env bash
# Install the Watchdog sub server as a systemd service (Linux).
#
#   1. cp .env.example .env   and paste MAIN_SERVER_URL + AGENT_TOKEN from the main server
#   2. sudo bash install.sh
#
# Re-run it after changing .env or updating the code.
set -euo pipefail

[[ $EUID -eq 0 ]] || { echo "Run as root: sudo bash install.sh"; exit 1; }
command -v systemctl >/dev/null || { echo "systemd not found. Run it with 'npm start' (or pm2) instead."; exit 1; }
command -v node >/dev/null || { echo "Node.js 18+ is required: https://nodejs.org/en/download"; exit 1; }
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
(( NODE_MAJOR >= 18 )) || { echo "Node.js 18+ is required (found $(node -v))."; exit 1; }

SRC="$(cd "$(dirname "$0")" && pwd)"
DEST=/opt/watchdog-sub-server

[[ -f "$SRC/.env" ]] || { echo "No .env found. Run: cp .env.example .env  and paste your token into it."; exit 1; }
grep -q '^AGENT_TOKEN=wd_' "$SRC/.env" && ! grep -q 'paste_your_token' "$SRC/.env" \
  || { echo ".env has no AGENT_TOKEN yet. Get one on the main server with /add <name>."; exit 1; }

echo "==> Copying to $DEST"
mkdir -p "$DEST"
cp -r "$SRC/package.json" "$SRC/src" "$DEST/"
[[ -f "$SRC/package-lock.json" ]] && cp "$SRC/package-lock.json" "$DEST/"
install -m 600 "$SRC/.env" "$DEST/.env"

echo "==> Installing dependencies"
cd "$DEST" && npm install --omit=dev --no-audit --no-fund --loglevel=error

echo "==> Installing systemd service"
sed "s#@NODE@#$(command -v node)#" "$SRC/watchdog-sub-server.service" > /etc/systemd/system/watchdog-sub-server.service
systemctl daemon-reload
systemctl enable watchdog-sub-server >/dev/null
systemctl restart watchdog-sub-server
sleep 3
systemctl --no-pager --lines=6 status watchdog-sub-server || true
echo
echo "Done. You should get a Telegram message that this server connected."
echo "Logs: journalctl -u watchdog-sub-server -f"
