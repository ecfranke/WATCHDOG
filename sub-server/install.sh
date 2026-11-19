#!/usr/bin/env bash
# Install (or update) the Watchdog sub server as a systemd service, with auto-update from GitHub.
#
# A) From a clone of your repo:
#      cd sub-server && cp .env.example .env     # paste MAIN_SERVER_URL + AGENT_TOKEN
#      sudo bash install.sh
#
# B) One line, nothing cloned yet (the bot's /add reply gives you this ready-made):
#      curl -fsSL https://raw.githubusercontent.com/OWNER/REPO/main/sub-server/install.sh | sudo bash -s -- \
#        --repo https://github.com/OWNER/REPO.git --main https://watchdog.example.com --token wd_xxx
#
# Options:
#   --repo URL            GitHub repository to install from and pull updates from
#                         (default: the repo this script is in)
#   --branch NAME         branch to follow (default: current branch, or main)
#   --main URL            MAIN_SERVER_URL  ┐ write a new .env with these
#   --token TOKEN         AGENT_TOKEN      ┘
#   --github-token TOKEN  for a private repository (fine-grained token, read-only "Contents")
#   --no-auto-update      install, but only update when you ask (/update in Telegram)
#   --dir PATH            install location (default /opt/watchdog)
set -euo pipefail

REPO=""; BRANCH=""; MAIN=""; TOKEN=""; GH_TOKEN=""; DIR="/opt/watchdog"; AUTO="true"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo) REPO="$2"; shift 2;;
    --branch) BRANCH="$2"; shift 2;;
    --main) MAIN="$2"; shift 2;;
    --token) TOKEN="$2"; shift 2;;
    --github-token) GH_TOKEN="$2"; shift 2;;
    --no-auto-update) AUTO="false"; shift;;
    --dir) DIR="$2"; shift 2;;
    -h|--help) sed -n '2,22p' "$0" 2>/dev/null || true; exit 0;;
    *) echo "Unknown option: $1"; exit 1;;
  esac
done
die() { echo "✖ $*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "Run as root (sudo)."
command -v systemctl >/dev/null || die "systemd not found. Run it with 'npm start' (or pm2) instead."
command -v node >/dev/null || die "Node.js 18+ is required: https://nodejs.org/en/download"
(( $(node -p 'process.versions.node.split(".")[0]') >= 18 )) || die "Node.js 18+ is required (found $(node -v))."
if ! command -v git >/dev/null; then
  echo "==> Installing git"
  if command -v apt-get >/dev/null; then apt-get update -qq && apt-get install -y -qq git
  elif command -v dnf >/dev/null; then dnf install -y -q git
  elif command -v yum >/dev/null; then yum install -y -q git
  else die "Please install git."; fi
fi

# Where is this script? (empty when piped through curl | bash)
SRC_DIR=""
if [[ -n "${BASH_SOURCE[0]:-}" && -f "${BASH_SOURCE[0]}" ]]; then
  SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fi
if [[ -z "$REPO" && -n "$SRC_DIR" ]] && git -C "$SRC_DIR" rev-parse --git-dir >/dev/null 2>&1; then
  REPO="$(git -C "$SRC_DIR" remote get-url origin 2>/dev/null || true)"
  [[ -z "$BRANCH" ]] && BRANCH="$(git -C "$SRC_DIR" rev-parse --abbrev-ref HEAD)"
fi
BRANCH="${BRANCH:-main}"
APP="$DIR/sub-server"

GIT_AUTH=()
if [[ -n "$GH_TOKEN" ]]; then
  GIT_AUTH=(-c "http.https://github.com/.extraheader=AUTHORIZATION: basic $(printf 'x-access-token:%s' "$GH_TOKEN" | base64 | tr -d '\n')")
fi
g() { git ${GIT_AUTH[@]+"${GIT_AUTH[@]}"} "$@"; }

# ---------------------------------------------------------------- code
if [[ -n "$REPO" ]]; then
  if [[ -d "$DIR/.git" ]]; then
    echo "==> Updating $DIR from $BRANCH"
    g -C "$DIR" fetch --quiet origin "$BRANCH"
    git -C "$DIR" checkout -q "$BRANCH" 2>/dev/null || git -C "$DIR" checkout -q -b "$BRANCH" "origin/$BRANCH"
    git -C "$DIR" reset -q --hard "origin/$BRANCH"
  else
    [[ -e "$DIR" && -n "$(ls -A "$DIR" 2>/dev/null)" ]] && die "$DIR exists and is not a git clone. Remove it or use --dir."
    echo "==> Cloning $(echo "$REPO" | sed -E 's#//[^@/]+@#//#') ($BRANCH) into $DIR"
    g clone -q --branch "$BRANCH" "$REPO" "$DIR"
  fi
  [[ -d "$APP" ]] || die "The repository has no sub-server/ folder."
else
  [[ -n "$SRC_DIR" ]] || die "Pass --repo https://github.com/OWNER/REPO.git"
  echo "==> No git repository found: copying files. Auto-update needs a git clone (use --repo)."
  mkdir -p "$APP"
  cp -r "$SRC_DIR/package.json" "$SRC_DIR/src" "$SRC_DIR/watchdog-sub-server.service" "$APP/"
  [[ -f "$SRC_DIR/package-lock.json" ]] && cp "$SRC_DIR/package-lock.json" "$APP/"
  [[ -d "$SRC_DIR/../shared" ]] && mkdir -p "$DIR/shared" && cp -r "$SRC_DIR/../shared/." "$DIR/shared/"
fi

# ---------------------------------------------------------------- .env
ENV_FILE="$APP/.env"
if [[ -n "$MAIN$TOKEN" ]]; then
  [[ -n "$MAIN" && -n "$TOKEN" ]] || die "--main and --token must be given together."
  echo "==> Writing $ENV_FILE"
  umask 077
  {
    echo "MAIN_SERVER_URL=$MAIN"
    echo "AGENT_TOKEN=$TOKEN"
    echo "INTERVAL_SECONDS=5"
    echo "AUTO_UPDATE=$AUTO"
    echo "UPDATE_CHECK_MINUTES=30"
    [[ -n "$GH_TOKEN" ]] && echo "UPDATE_GITHUB_TOKEN=$GH_TOKEN"
  } > "$ENV_FILE"
  umask 022
elif [[ -n "$SRC_DIR" && -f "$SRC_DIR/.env" && "$(realpath "$SRC_DIR/.env")" != "$(realpath -m "$ENV_FILE")" ]]; then
  echo "==> Copying .env"
  install -m 600 "$SRC_DIR/.env" "$ENV_FILE"
fi
[[ -f "$ENV_FILE" ]] || die "No .env yet. Use --main URL --token TOKEN, or create $ENV_FILE from .env.example."
grep -q '^AGENT_TOKEN=wd_' "$ENV_FILE" && ! grep -q 'paste_your_token' "$ENV_FILE" \
  || die "$ENV_FILE has no AGENT_TOKEN. Get one on the main server with /add <name>."
if [[ -n "$GH_TOKEN" ]] && ! grep -q '^UPDATE_GITHUB_TOKEN=' "$ENV_FILE"; then echo "UPDATE_GITHUB_TOKEN=$GH_TOKEN" >> "$ENV_FILE"; fi
chmod 600 "$ENV_FILE"

# ---------------------------------------------------------------- deps + service
echo "==> Installing dependencies"
cd "$APP"
if [[ -f package-lock.json ]]; then npm ci --omit=dev --no-audit --no-fund --loglevel=error
else npm install --omit=dev --no-audit --no-fund --loglevel=error; fi

echo "==> Installing systemd service"
sed -e "s#@NODE@#$(command -v node)#g" -e "s#@APP@#$APP#g" "$APP/watchdog-sub-server.service" \
  > /etc/systemd/system/watchdog-sub-server.service
systemctl daemon-reload
systemctl enable watchdog-sub-server >/dev/null
systemctl restart watchdog-sub-server
sleep 3
systemctl --no-pager --lines=8 status watchdog-sub-server || true
echo
echo "Done. You should get a Telegram message that this server connected."
echo "Logs:   journalctl -u watchdog-sub-server -f"
[[ -d "$DIR/.git" ]] && echo "Updates: automatic from $BRANCH (or /update in Telegram)"
exit 0
