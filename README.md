# 🐕 Watchdog

Monitor many servers from Telegram. Written in Node.js.

```
                      ┌─────────────────────────────────────────┐
                      │  MAIN SERVER  (main-server/)            │
                      │  • Telegram bot + live dashboard        │
                      │  • creates / replaces / revokes a token │
                      │    for every sub server                 │
                      │  • detects down / up / reboot, alerts   │
                      └───────▲───────────▲───────────▲─────────┘
                    token A   │  token B  │  token C  │   HTTPS, every 5 s
                      ┌───────┴───┐ ┌─────┴─────┐ ┌───┴───────┐
                      │ SUB SERVER│ │ SUB SERVER│ │ SUB SERVER│   (sub-server/)
                      │  web-1    │ │  db-main  │ │  nas      │   .env holds its token
                      └───────────┘ └───────────┘ └───────────┘
```

- **main-server**: one per setup. It runs the bot and the dashboard. You add each sub server here and get a
  **unique token** for it. You can replace (rotate) or revoke a token at any time from Telegram or the dashboard.
- **sub-server**: deploy on every machine you want to watch. Paste its token into `.env` and start it. It
  sends CPU, RAM, temperature, disk, network and top processes to the main server.

Notifications you get:

| Event | Message |
|---|---|
| sub server connects for the first time | 🆕 connected |
| no report for 30 s | 🔴 **DOWN** |
| reports again | 🟢 back online (with downtime, "rebooted" if it did) |
| clean shutdown / reboot of the machine | ⏻ shutting down / rebooting |
| sub-server service stopped | ⏹ agent stopped |
| CPU / RAM / disk / temperature over the limit long enough | ⚠️ alert … then ✅ resolved |
| every 6 h | 🩺 health report (silent) |

> Run the main server on a machine that is **not** one of the sub servers (a small VPS is enough).
> If the main server's own machine goes down, nothing is left to tell you.

---

## 1. Main server

Needs **Node.js 18+**.

1. Create a bot with **@BotFather** (`/newbot`) and copy its token.
2. Set it up:

   ```bash
   cd main-server
   cp .env.example .env      # set BOT_TOKEN, ADMIN_IDS, PUBLIC_URL, WEBAPP_URL
   npm install
   npm start
   ```

   Don't know your Telegram ID for `ADMIN_IDS`? Put any number, start it, send `/start` to the bot, and it
   replies with your ID.

3. HTTPS: Telegram only opens the dashboard over HTTPS, and sub servers should report over HTTPS too.
   The easiest way is [Caddy](https://caddyserver.com), which gets a certificate automatically:

   ```
   watchdog.example.com {
       reverse_proxy localhost:8080
   }
   ```

   Then set `PUBLIC_URL=https://watchdog.example.com` and `WEBAPP_URL=https://watchdog.example.com/app/`.
   For a quick test without a domain, `cloudflared tunnel --url http://localhost:8080` gives you a
   temporary HTTPS address.

**Docker:** `cd main-server && docker compose up -d --build`

**systemd:** copy `main-server/` to `/opt/watchdog-main`, run `npm install --omit=dev`, create a user
(`useradd -r watchdog && chown -R watchdog: /opt/watchdog-main`), then install `watchdog-main.service` and run
`systemctl enable --now watchdog-main`.

Data (servers, hashed tokens, settings) is kept in `data/watchdog.json`.

## 2. Add a sub server → get its token

In Telegram, in a **private chat** with your bot:

```
/add web-1
```

The bot replies with the two lines for that server's `.env`:

```
MAIN_SERVER_URL=https://watchdog.example.com
AGENT_TOKEN=wd_Xb3k…
```

Or open the dashboard and tap **＋ Add server**. The token is shown **only once**. The main server
keeps only a hash of it. Lost it? `/token web-1` makes a new one, and the old one stops working immediately.

## 3. Deploy the sub server

On the machine you want to monitor (Node.js 18+):

```bash
cd sub-server
cp .env.example .env        # paste MAIN_SERVER_URL and AGENT_TOKEN
npm install
npm run check               # optional: prints what it measures, then exits
sudo bash install.sh        # installs a systemd service (or just: npm start)
```

`install.sh` copies the project to `/opt/watchdog-sub-server`, installs dependencies, and starts the
`watchdog-sub-server` service. You get **🆕 web-1 connected** in Telegram within seconds.

- Logs: `journalctl -u watchdog-sub-server -f`
- Changed the token? Edit `.env` and run `sudo bash install.sh` again.
- Without systemd (macOS, Windows, containers): `npm start`, or keep it running with `pm2 start src/agent.js --name watchdog`.
- Temperature: works on bare-metal Linux and most desktops. VMs and cloud servers usually have no sensors,
  so temperature is simply left out.

## Bot commands

| Command | |
|---|---|
| `/add <name>` | create a sub server and get its token |
| `/token <name>` | replace a server's token (old one revoked) |
| `/remove <name>` | remove a server and revoke its token |
| `/servers` | list servers, status and token age |
| `/status` | CPU / RAM / disk / temp of every server, with a refresh button |
| `/alerts` | servers down + active alerts |
| `/dashboard` | open the live dashboard |
| `/mute 60` · `/unmute` | silence notifications |

Only users in `ADMIN_IDS` can use the bot and the dashboard. Tokens are only sent in private chats.
Add a group to `ALERT_CHAT_IDS` (IDs start with `-100`) so your team gets alerts too.

## Main server settings (`.env`)

| Variable | Default | |
|---|---|---|
| `OFFLINE_AFTER_SECONDS` | 30 | silence before a sub server counts as down |
| `HEALTH_REPORT_INTERVAL_MINUTES` | 360 | 0 turns the report off |
| `CPU_ALERT_PERCENT` / `_FOR_SECONDS` | 90 / 120 | CPU must stay above 90 % for 2 min |
| `RAM_ALERT_PERCENT` / `_FOR_SECONDS` | 90 / 120 | |
| `DISK_ALERT_PERCENT` / `_FOR_SECONDS` | 90 / 0 | fullest disk |
| `TEMP_ALERT_CELSIUS` / `_FOR_SECONDS` | 80 / 60 | hottest sensor |
| `ALERT_HYSTERESIS` | 5 | how far below the limit before "resolved" |
| `HISTORY_MINUTES` | 60 | chart history kept in memory |
| `DEV_NO_AUTH` | false | open `http://localhost:8080/app/` in a browser without Telegram. **Never in production.** |

## Security

- Each sub server has its own token. Only its SHA-256 hash is stored, and you can revoke one without touching the others.
- The dashboard checks Telegram's signed `initData` (HMAC with the bot token) and your user ID on every
  request and WebSocket connection.
- The sub server only reads system stats. It runs as root so it can see every process and sensor.

## Layout

```
main-server/
  src/   index.js · server.js (API + WebSocket) · monitor.js (tokens, up/down, alerts)
         bot.js · notifier.js · telegramAuth.js · store.js · format.js · config.js
  public/index.html     Telegram Mini App (no build step)
  .env.example  Dockerfile  docker-compose.yml  watchdog-main.service
sub-server/
  src/   agent.js · collect.js
  .env.example  install.sh  watchdog-sub-server.service
```
