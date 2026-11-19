#!/usr/bin/env bash
# Install (or update) the Watchdog MAIN server on an aaPanel server, behind aaPanel's nginx.
#
# Before running: in aaPanel → Website → Add site → your domain (static, no database),
#                 then that site → SSL → Let's Encrypt, and turn on Force HTTPS.
#
# A) From a clone of your repo:     sudo bash main-server/install.sh
# B) One line, nothing cloned yet:
#      curl -fsSL https://raw.githubusercontent.com/OWNER/REPO/main/main-server/install.sh | sudo bash -s -- \
#        --repo https://github.com/OWNER/REPO.git
#
# Options:
#   --repo URL            GitHub repository (default: the repo this script is in)
#   --branch NAME         branch to follow (default: current branch, or main)
#   --dir PATH            install location (default /opt/watchdog)
#   --domain D --port P --bot-token T --admin-ids IDS   answer setup questions up front
#   --reconfigure         ask the setup questions again (port, domain, bot) even if .env exists
#   --vhost FILE          nginx site config to edit (default: found from the domain; aaPanel or /etc/nginx)
#   --no-nginx            don't touch nginx (print the block instead)
#   --github-token TOKEN  for a private repository
#   --user NAME           system user that runs the service (default watchdog)
set -euo pipefail

REPO=""; BRANCH=""; DIR=""; GH_TOKEN=""; RECONF=false; VHOST=""; NO_NGINX=false; RUN_USER="watchdog"
SETUP_ARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo) REPO="$2"; shift 2;;
    --branch) BRANCH="$2"; shift 2;;
    --dir) DIR="$2"; shift 2;;
    --github-token) GH_TOKEN="$2"; shift 2;;
    --reconfigure) RECONF=true; shift;;
    --vhost) VHOST="$2"; shift 2;;
    --no-nginx) NO_NGINX=true; shift;;
    --user) RUN_USER="$2"; shift 2;;
    --domain|--port|--bot-token|--admin-ids|--timezone) SETUP_ARGS+=("$1" "$2"); shift 2;;
    -h|--help) sed -n '2,24p' "$0" 2>/dev/null || true; exit 0;;
    *) echo "Unknown option: $1"; exit 1;;
  esac
done
die() { echo "✖ $*" >&2; exit 1; }
step() { echo; echo "==> $*"; }

[[ $EUID -eq 0 ]] || die "Run as root (sudo)."

# Re-running? Keep using the existing install unless --dir says otherwise.
if [[ -z "$DIR" && -f /etc/systemd/system/watchdog-main.service ]]; then
  existing="$(sed -n 's/^WorkingDirectory=//p' /etc/systemd/system/watchdog-main.service)"
  [[ -n "$existing" && -d "$existing" ]] && DIR="$(dirname "$existing")"
fi
DIR="${DIR:-/opt/watchdog}"
command -v systemctl >/dev/null || die "systemd is required."

# ---------------------------------------------------------------- Node.js (system, or aaPanel's Node.js manager)
NODE="$(command -v node || true)"
node_major() { "$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }
if [[ -z "$NODE" || $(node_major "$NODE") -lt 18 ]]; then
  for n in $(ls -d /www/server/nodejs/v*/bin/node 2>/dev/null | sort -V -r); do
    if [[ $(node_major "$n") -ge 18 ]]; then NODE="$n"; break; fi
  done
fi
[[ -n "$NODE" && $(node_major "$NODE") -ge 18 ]] || die "Node.js 18+ not found. Install it in aaPanel → App Store → Node.js version manager (pick v20), or from https://nodejs.org"
NPM="$(dirname "$NODE")/npm"; [[ -x "$NPM" ]] || NPM="$(command -v npm || true)"
[[ -n "$NPM" ]] || die "npm not found next to $NODE"
export PATH="$(dirname "$NODE"):$PATH"
echo "Using Node.js $("$NODE" -v) at $NODE"

if ! command -v git >/dev/null; then
  step "Installing git"
  if command -v apt-get >/dev/null; then apt-get update -qq && apt-get install -y -qq git
  elif command -v dnf >/dev/null; then dnf install -y -q git
  elif command -v yum >/dev/null; then yum install -y -q git
  else die "Please install git."; fi
fi

# ---------------------------------------------------------------- code
SRC_DIR=""
if [[ -n "${BASH_SOURCE[0]:-}" && -f "${BASH_SOURCE[0]}" ]]; then SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; fi
if [[ -z "$REPO" && -n "$SRC_DIR" ]] && git -C "$SRC_DIR" rev-parse --git-dir >/dev/null 2>&1; then
  REPO="$(git -C "$SRC_DIR" remote get-url origin 2>/dev/null || true)"
  [[ -z "$BRANCH" ]] && BRANCH="$(git -C "$SRC_DIR" rev-parse --abbrev-ref HEAD)"
fi
BRANCH="${BRANCH:-main}"
APP="$DIR/main-server"
GIT_AUTH=()
if [[ -n "$GH_TOKEN" ]]; then
  GIT_AUTH=(-c "http.https://github.com/.extraheader=AUTHORIZATION: basic $(printf 'x-access-token:%s' "$GH_TOKEN" | base64 | tr -d '\n')")
fi
g() { git ${GIT_AUTH[@]+"${GIT_AUTH[@]}"} "$@"; }

# the clone belongs to the service user; let root (this installer) use it too
git config --system --get-all safe.directory 2>/dev/null | grep -qx "$DIR" || git config --system --add safe.directory "$DIR" 2>/dev/null || true

if [[ -n "$REPO" ]]; then
  if [[ -d "$DIR/.git" ]]; then
    step "Updating $DIR ($BRANCH)"
    g -C "$DIR" fetch --quiet origin "$BRANCH"
    git -C "$DIR" checkout -q "$BRANCH" 2>/dev/null || git -C "$DIR" checkout -q -b "$BRANCH" "origin/$BRANCH"
    git -C "$DIR" reset -q --hard "origin/$BRANCH"
  else
    [[ -e "$DIR" && -n "$(ls -A "$DIR" 2>/dev/null)" ]] && die "$DIR exists and is not a git clone. Remove it or use --dir."
    step "Cloning $(echo "$REPO" | sed -E 's#//[^@/]+@#//#') ($BRANCH) into $DIR"
    g clone -q --branch "$BRANCH" "$REPO" "$DIR"
  fi
else
  [[ -n "$SRC_DIR" ]] || die "Pass --repo https://github.com/OWNER/REPO.git"
  step "No git repository found: copying files (auto-update needs a git clone, use --repo)"
  mkdir -p "$APP"
  cp -r "$SRC_DIR/." "$APP/"
  rm -rf "$APP/node_modules"
  [[ -d "$SRC_DIR/../shared" ]] && mkdir -p "$DIR/shared" && cp -r "$SRC_DIR/../shared/." "$DIR/shared/"
fi
[[ -d "$APP/src" ]] || die "The repository has no main-server/ folder."

step "Installing dependencies"
cd "$APP"
if [[ -f package-lock.json ]]; then "$NPM" ci --omit=dev --no-audit --no-fund --loglevel=error
else "$NPM" install --omit=dev --no-audit --no-fund --loglevel=error; fi

# ---------------------------------------------------------------- configuration (.env)
if [[ ! -f .env && -n "$SRC_DIR" && -f "$SRC_DIR/.env" && "$(realpath "$SRC_DIR")" != "$(realpath "$APP")" ]]; then
  cp "$SRC_DIR/.env" .env
fi
if [[ ! -f .env || "$RECONF" == true || ${#SETUP_ARGS[@]} -gt 0 ]]; then
  step "Setup"
  if [[ ${#SETUP_ARGS[@]} -gt 0 && -f .env ]]; then
    "$NODE" scripts/setup.js --from-installer --yes ${SETUP_ARGS[@]+"${SETUP_ARGS[@]}"}
  elif [[ -r /dev/tty ]] && { : < /dev/tty; } 2>/dev/null; then
    "$NODE" scripts/setup.js --from-installer ${SETUP_ARGS[@]+"${SETUP_ARGS[@]}"} < /dev/tty
  else
    "$NODE" scripts/setup.js --from-installer --yes ${SETUP_ARGS[@]+"${SETUP_ARGS[@]}"}
  fi
fi
[[ -f .env ]] || die "No .env — setup did not finish."
chmod 600 .env
env_get() { sed -n "s/^$1=//p" .env | tail -1 | tr -d '\r'; }
PORT="$(env_get PORT)"; PORT="${PORT:-8080}"
HOST="$(env_get HOST)"; HOST="${HOST:-127.0.0.1}"
PUBLIC_URL="$(env_get PUBLIC_URL)"
DOMAIN="$(echo "$PUBLIC_URL" | sed -E 's#^https?://##; s#[:/].*$##')"

# ---------------------------------------------------------------- user + service
step "Service"
id "$RUN_USER" >/dev/null 2>&1 || useradd --system --home-dir "$DIR" --shell /usr/sbin/nologin "$RUN_USER"
chown -R "$RUN_USER": "$DIR"
sed -e "s#@NODE@#$NODE#g" -e "s#@NODE_DIR@#$(dirname "$NODE")#g" -e "s#@APP@#$APP#g" -e "s#@USER@#$RUN_USER#g" "$APP/watchdog-main.service" \
  > /etc/systemd/system/watchdog-main.service
systemctl daemon-reload
systemctl enable watchdog-main >/dev/null
systemctl restart watchdog-main

ok=false
for _ in $(seq 1 20); do
  if curl --noproxy '*' -fsS -m 2 "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then ok=true; break; fi
  sleep 0.5
done
if [[ "$ok" != true ]]; then
  journalctl -u watchdog-main -n 20 --no-pager 2>/dev/null || true
  die "The main server did not come up on 127.0.0.1:$PORT (see the log above)."
fi
echo "✔ Running on $HOST:$PORT"

# ---------------------------------------------------------------- nginx (aaPanel)
if [[ "$NO_NGINX" == true || "$HOST" == "0.0.0.0" && -z "$VHOST" ]]; then
  step "nginx: skipped"
  "$NODE" scripts/nginx.js >/dev/null
  echo "The proxy block is in $APP/nginx/watchdog.conf"
else
  step "nginx: adding Watchdog to the site $DOMAIN"
  "$NODE" scripts/nginx.js --apply ${VHOST:+--vhost "$VHOST"} || {
    code=$?
    [[ $code -eq 2 ]] && echo "   Then run this installer again (your settings are kept)."
    exit $code
  }
  chown -R "$RUN_USER": "$APP/nginx" 2>/dev/null || true

  # end-to-end check through nginx (works before DNS points here)
  if curl --noproxy '*' -fsS -m 5 --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/healthz" >/dev/null 2>&1 ||
     curl --noproxy '*' -fsS -m 5 -k --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/healthz" >/dev/null 2>&1; then
    echo "✔ https://$DOMAIN/healthz answers through nginx"
  elif curl --noproxy '*' -fsS -m 5 --resolve "$DOMAIN:80:127.0.0.1" "http://$DOMAIN/healthz" >/dev/null 2>&1; then
    echo "⚠ Works over http://$DOMAIN but not HTTPS yet: aaPanel → Website → $DOMAIN → SSL → Let's Encrypt"
  else
    echo "⚠ Could not reach https://$DOMAIN/healthz through nginx from this machine. Check the site in aaPanel."
  fi
fi

cat <<EOF

Done.
  Dashboard:   ${PUBLIC_URL}/app/   (open it from the bot in Telegram)
  Logs:        journalctl -u watchdog-main -f
  Settings:    $APP/.env   (change port/domain: sudo bash $APP/install.sh --reconfigure)
  Updates:     automatic from GitHub ($BRANCH), or /update main in Telegram

Next: send /start to your bot, then /add <name> for each server you want to watch.
EOF
