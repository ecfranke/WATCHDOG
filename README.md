# 🐕 Watchdog

Monitor many servers from Telegram, with auto-update from GitHub. Written in Node.js.

```
                           GitHub repo (this project)
                    git pull ▲          ▲ git pull
                             │          │
                      ┌──────┴──────────┴───────────────────────┐
                      │  MAIN SERVER  (main-server/)            │
                      │  • Telegram bot + live dashboard        │
                      │  • creates / replaces / revokes a token │
                      │    for every sub server                 │
                      │  • down / up / reboot alerts            │
                      │  • /update: tells sub servers to update │
                      └───────▲───────────▲───────────▲─────────┘
                    token A   │  token B  │  token C  │   HTTPS, every 5 s
                      ┌───────┴───┐ ┌─────┴─────┐ ┌───┴───────┐
                      │ SUB SERVER│ │ SUB SERVER│ │ SUB SERVER│   (sub-server/)
                      │  web-1    │ │  db-main  │ │  nas      │   .env holds its token,
                      └───────────┘ └───────────┘ └───────────┘   each pulls updates from GitHub
```

- **main-server**: one per setup. It runs the bot and the dashboard. You add each sub server here and get a
  **unique token** for it. You can replace or revoke a token at any time.
- **sub-server**: deploy on every machine you want to watch. Its token goes in `.env`. It reports CPU, RAM,
  temperature, disk, network and top processes.
- **shared/updater.js**: auto-update used by both. Every install is a git clone of your GitHub repo. It
  checks for new commits, pulls them, checks the code, and restarts. A bad update is rolled back.

| Event | Telegram message |
|---|---|
| sub server connects for the first time | 🆕 connected |
| no report for 30 s | 🔴 **DOWN** |
| reports again | 🟢 back online (with downtime, "rebooted" if it did) |
| machine shuts down / reboots | ⏻ shutting down / rebooting |
| sub-server service stopped | ⏹ agent stopped |
| CPU / RAM / disk / temperature over the limit | ⚠️ alert … then ✅ resolved |
| a server installed a new version | ⬆️ updated `abc1234` → `def5678` |
| an update failed (and was rolled back) | ❗ update failed + reason |
| every 6 h | 🩺 health report (silent) |

> Run the main server on a machine that is **not** one of the sub servers (a small VPS is enough).

---

## 0. Put the project on GitHub

Push this folder to a GitHub repository, for example `github.com/you/watchdog`. A **public** repo is
simplest: the bot can then give you a one-line installer for each sub server. A **private** repo works too.
Create a fine-grained token with read-only *Contents* access and pass it as `UPDATE_GITHUB_TOKEN`
(main server `.env`) and `--github-token` (sub server installer).

From then on, **every push to `main` is a release**. All servers pick it up within 30 minutes, or
right away with `/update all`.

## 1. Main server

Needs Node.js 18+ and git.

```bash
sudo git clone https://github.com/you/watchdog.git /opt/watchdog
cd /opt/watchdog/main-server
sudo cp .env.example .env        # set BOT_TOKEN, ADMIN_IDS, PUBLIC_URL, WEBAPP_URL
sudo npm ci --omit=dev
sudo useradd -r watchdog && sudo chown -R watchdog: /opt/watchdog
sudo cp watchdog-main.service /etc/systemd/system/ && sudo systemctl enable --now watchdog-main
```

- Get a bot token from **@BotFather** (`/newbot`).
- Don't know your Telegram ID for `ADMIN_IDS`? Put any number, start it, send `/start` to the bot, and it
  replies with your ID.
- **HTTPS** is required for the dashboard. With [Caddy](https://caddyserver.com) in front:

  ```
  watchdog.example.com {
      reverse_proxy localhost:8080
  }
  ```

  then `PUBLIC_URL=https://watchdog.example.com` and `WEBAPP_URL=https://watchdog.example.com/app/`.
  For a quick test without a domain: `cloudflared tunnel --url http://localhost:8080`.
- The service must run under systemd or pm2 (anything that restarts it). That's how an update takes
  effect. With plain `npm start` the update is downloaded and you're told to restart.
- Docker (`docker compose up -d --build`) works too, but then auto-update is off. Update with
  `git pull && docker compose up -d --build`.

## 2. Add a sub server → get its token

In a **private chat** with your bot: `/add web-1`. Or in the dashboard: **＋ Add server**.

You get the `.env` lines **and** (with a public repo) a ready-made one-line installer:

```bash
curl -fsSL https://raw.githubusercontent.com/you/watchdog/main/sub-server/install.sh | sudo bash -s -- \
  --repo https://github.com/you/watchdog.git --branch main \
  --main https://watchdog.example.com --token wd_Xb3k…
```

The token is shown **only once**, and the main server only keeps a hash of it. Lost it? `/token web-1` makes a
new one, and the old token stops working immediately.

## 3. Deploy the sub server

On the machine to monitor (Linux with systemd, Node.js 18+), **paste the one-liner** from step 2. Or:

```bash
git clone https://github.com/you/watchdog.git && cd watchdog/sub-server
cp .env.example .env            # paste MAIN_SERVER_URL + AGENT_TOKEN
npm ci && npm run check         # optional: prints what it measures
sudo bash install.sh            # → /opt/watchdog, systemd service, auto-update on
```

Installer options: `--github-token TOKEN` (private repo), `--branch NAME`, `--no-auto-update`,
`--dir PATH`. Running it again updates the install and keeps `.env`.

- Logs: `journalctl -u watchdog-sub-server -f`
- New token? Edit `/opt/watchdog/sub-server/.env`, then `sudo systemctl restart watchdog-sub-server`.
- Without systemd (macOS, Windows): run it from a git clone with `pm2 start src/agent.js --name watchdog`.
- Temperature is reported where the hardware exposes sensors (bare-metal Linux, most desktops). VMs usually have none.

## Updates

| How | What happens |
|---|---|
| automatic | every `UPDATE_CHECK_MINUTES` (30) each server runs `git fetch`; if `main` moved, it updates itself |
| `/update all` | every sub server updates on its next report (seconds), then the main server |
| `/update web-1` · `/update main` | just that one |
| dashboard | **⬆ Update from GitHub** on a server's page; **Update** next to the main server version at the bottom |
| `/version` | which commit each server runs, and who is behind GitHub |

An update goes like this: fetch → `git reset --hard origin/main` → `npm ci` if dependencies changed → `node
--check` on every source file → restart. If any step fails, the server goes back to the commit it was on,
keeps running, and you get **❗ update failed** with the reason.

Safety rules:
- **Local edits are never overwritten.** If tracked files were changed by hand, auto-update pauses and
  tells you.
- A change that doesn't touch that server's folder (e.g. only README or main-server) updates the files
  without restarting it.
- Sub servers restart in about 2 seconds without sending "goodbye", so an update never triggers a down alert.
- Set `AUTO_UPDATE=false` to update only when you say so (`/update`).

## Bot commands

| Command | |
|---|---|
| `/add <name>` | create a sub server and get its token (+ installer) |
| `/token <name>` | replace a server's token (old one revoked) |
| `/remove <name>` | remove a server and revoke its token |
| `/servers` | list servers, status and token age |
| `/status` | CPU / RAM / disk / temp of every server |
| `/alerts` | servers down + active alerts |
| `/version` | versions vs. GitHub |
| `/update all \| main \| <name>` | update now |
| `/dashboard` | open the live dashboard |
| `/mute 60` · `/unmute` | silence notifications |

Only users in `ADMIN_IDS` can use the bot and dashboard. Tokens are only sent in private chats.

## Settings

Main server `.env`:

| Variable | Default | |
|---|---|---|
| `OFFLINE_AFTER_SECONDS` | 30 | silence before a sub server counts as down |
| `HEALTH_REPORT_INTERVAL_MINUTES` | 360 | 0 turns the report off |
| `CPU_ALERT_PERCENT` / `_FOR_SECONDS` | 90 / 120 | |
| `RAM_ALERT_PERCENT` / `_FOR_SECONDS` | 90 / 120 | |
| `DISK_ALERT_PERCENT` / `_FOR_SECONDS` | 90 / 0 | fullest disk |
| `TEMP_ALERT_CELSIUS` / `_FOR_SECONDS` | 80 / 60 | hottest sensor |
| `ALERT_HYSTERESIS` | 5 | how far below the limit before "resolved" |
| `AUTO_UPDATE` · `UPDATE_CHECK_MINUTES` · `UPDATE_BRANCH` · `UPDATE_GITHUB_TOKEN` | true · 30 · checked-out branch · — | |
| `DEV_NO_AUTH` | false | open `http://localhost:8080/app/` without Telegram. **Never in production.** |

Sub server `.env`: `MAIN_SERVER_URL`, `AGENT_TOKEN`, `INTERVAL_SECONDS` (5), plus the same `AUTO_UPDATE`,
`UPDATE_CHECK_MINUTES`, `UPDATE_BRANCH`, `UPDATE_GITHUB_TOKEN`.

## Security

- Each sub server has its own token. Only its SHA-256 hash is stored, and you can revoke one without touching the others.
- The dashboard checks Telegram's signed `initData` and your user ID on every request and WebSocket.
- Auto-update runs whatever is pushed to the branch, so protect the branch on GitHub (who can push).
- The sub server runs as root so it can read every process and sensor. It only reads system stats.

## Layout

```
main-server/   src/ (index, server, monitor, bot, notifier, telegramAuth, store, format, config)
               public/index.html (Telegram Mini App) · .env.example · Dockerfile · watchdog-main.service
sub-server/    src/ (agent, collect) · .env.example · install.sh · watchdog-sub-server.service
shared/        updater.js (git-based auto-update used by both)
```
