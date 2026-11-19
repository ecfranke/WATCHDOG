#!/usr/bin/env node
// Interactive setup for the main server: writes .env and the nginx config for aaPanel.
//
//   npm run setup
//   npm run setup -- --domain watchdog.example.com --port 8090 --bot-token 123:AA… --admin-ids 111 --yes
//
// Re-run any time to change the port, domain or bot settings; current values are the defaults.
// Flags answer a question without asking; --yes accepts the default for everything else.
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { buildNginx, writeNginxFile } from "./nginx.js";

const APP_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENV_FILE = path.join(APP_DIR, ".env");
const EXAMPLE = path.join(APP_DIR, ".env.example");

const current = fs.existsSync(ENV_FILE) ? dotenv.parse(fs.readFileSync(ENV_FILE)) : {};
// Queue input lines so this works both interactively and with piped answers.
const rl = readline.createInterface({ input: process.stdin, terminal: false });
const lines = [];
let waiting = null;
let ended = false;
rl.on("line", (l) => (waiting ? (waiting(l), (waiting = null)) : lines.push(l)));
rl.on("close", () => {
  ended = true;
  waiting?.(null);
});
const nextLine = () =>
  lines.length ? Promise.resolve(lines.shift()) : ended ? Promise.resolve(null) : new Promise((r) => (waiting = r));

const flag = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : undefined;
};
const YES = process.argv.includes("--yes");
const FROM_INSTALLER = process.argv.includes("--from-installer");

async function ask(question, def = "", validate = () => null, preset = undefined) {
  if (preset !== undefined || (YES && def !== "")) {
    const answer = String(preset ?? def).trim();
    const problem = validate(answer);
    if (problem) {
      console.error(`✖ ${question}: ${problem}`);
      process.exit(1);
    }
    console.log(`${question}: ${answer}`);
    return answer;
  }
  if (YES) {
    console.error(`✖ ${question}: no value (pass it as a flag)`);
    process.exit(1);
  }
  for (;;) {
    const shown = def ? ` [${def}]` : "";
    process.stdout.write(`${question}${shown}: `);
    const line = await nextLine();
    if (line === null) {
      console.log("\nInput ended; nothing saved.");
      process.exit(1);
    }
    if (!process.stdin.isTTY) console.log(line);
    const answer = line.trim() || def;
    const problem = validate(answer);
    if (!problem) return answer;
    console.log(`  ✖ ${problem}`);
  }
}

function portFree(port, host) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(port, host);
  });
}

async function nextFreePort(start, host) {
  for (let p = start; p < start + 200 && p <= 65535; p++) if (await portFree(p, host)) return p;
  return null;
}

/** Set KEY=value in the .env text, keeping comments and other keys. */
function setKey(text, key, value) {
  const line = `${key}=${value}`;
  const re = new RegExp(`^#?\\s*${key}=.*$`, "m");
  return re.test(text) ? text.replace(re, line) : `${text.trimEnd()}\n${line}\n`;
}

function hostFromUrl(u) {
  try {
    return new URL(u).host;
  } catch {
    return "";
  }
}

console.log("\n🐕 Watchdog main server setup\n");

const botToken = await ask("Telegram bot token (from @BotFather)", current.BOT_TOKEN || "", (v) =>
  /^\d+:[\w-]{30,}$/.test(v) ? null : "looks wrong — it should look like 123456789:AA…",
  flag("bot-token"),
);
const adminIds = await ask("Admin Telegram user IDs (comma separated; unknown? use 0 and send /start to the bot later)", current.ADMIN_IDS || "", (v) =>
  /^\s*-?\d+(\s*[,;\s]\s*-?\d+)*\s*$/.test(v) ? null : "numbers only, e.g. 111111111,222222222",
  flag("admin-ids"),
);

const domainIn = await ask(
  "Domain of this main server, as set up in aaPanel (e.g. watchdog.example.com)",
  hostFromUrl(current.PUBLIC_URL || ""),
  (v) => (v && !/\s/.test(v) ? null : "enter a domain like watchdog.example.com"),
  flag("domain"),
);

const timezone = await ask(
  "Time zone for times in Telegram messages (e.g. America/Toronto)",
  current.TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  (v) => {
    try {
      new Intl.DateTimeFormat("en-GB", { timeZone: v });
      return null;
    } catch {
      return "unknown time zone — use a name like America/Toronto or Europe/London";
    }
  },
  flag("timezone"),
);

const behindProxy = /^y/i.test(
  await ask("Is aaPanel / nginx in front of it (recommended)? y/n", "y", () => null, process.argv.includes("--direct") ? "n" : undefined),
);
const host = behindProxy ? "127.0.0.1" : "0.0.0.0";

// Keep an already-configured port (it is "in use" when Watchdog itself is running); for a new setup, suggest a free one.
const curPort = Number(current.PORT || 8080);
const suggested = current.PORT || (await portFree(curPort, host)) ? curPort : await nextFreePort(curPort + 1, host);
if (suggested !== curPort) console.log(`  Port ${curPort} is in use on this machine; suggesting ${suggested}.`);
const port = Number(
  await ask("Local port for the Node app (any free port; aaPanel forwards HTTPS to it)", String(suggested || 8080), (v) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1024 || n > 65535) return "pick a number between 1024 and 65535";
    return null;
  }, flag("port")),
);
if (!(await portFree(port, host))) {
  console.log(`  ⚠ Port ${port} is in use right now. Fine if that's a running Watchdog you're reconfiguring; otherwise pick another.`);
}
rl.close();

const publicUrl = /^https?:\/\//.test(domainIn)
  ? domainIn.replace(/\/+$/, "")
  : behindProxy ? `https://${domainIn}` : `http://${domainIn}:${port}`;

// ---- write .env
let text = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, "utf8") : fs.readFileSync(EXAMPLE, "utf8");
for (const [k, v] of Object.entries({
  BOT_TOKEN: botToken,
  ADMIN_IDS: adminIds,
  PUBLIC_URL: publicUrl,
  WEBAPP_URL: `${publicUrl}/app/`,
  HOST: host,
  PORT: port,
  TIMEZONE: timezone,
})) text = setKey(text, k, v);
fs.writeFileSync(ENV_FILE, text, { mode: 0o600 });

// ---- nginx config
const conf = buildNginx({ port, publicUrl });
const confFile = writeNginxFile(conf);

const domain = hostFromUrl(publicUrl);
if (FROM_INSTALLER) {
  console.log(`\n✅ Saved .env  (PORT=${port}, HOST=${host}, PUBLIC_URL=${publicUrl})`);
  process.exit(0);
}
console.log(`
✅ Saved ${path.relative(process.cwd(), ENV_FILE) || ".env"}  (PORT=${port}, HOST=${host}, PUBLIC_URL=${publicUrl})
✅ Saved ${path.relative(process.cwd(), confFile)}
${
  behindProxy
    ? `
Next, in aaPanel:
  1. Website → Add site → domain: ${domain}  (PHP: static, no database)
  2. That site → SSL → Let's Encrypt → apply, then turn on "Force HTTPS"
  3. Put the proxy into that site:  sudo npm run nginx -- --apply
     (or paste the block below into the site's Config, right after "#SSL-END"; don't also add a "Reverse proxy")

${conf}
  4. Start the main server:  sudo systemctl restart watchdog-main   (or: npm start)
  5. Check: open ${publicUrl}/healthz → {"ok":true,...}

Port ${port} only listens on 127.0.0.1, so you don't need to open it in the aaPanel firewall.
Sub servers use MAIN_SERVER_URL=${publicUrl}`
    : `
The app will listen on 0.0.0.0:${port}. Open port ${port} in aaPanel → Security (and any cloud firewall).
Note: the Telegram dashboard needs HTTPS, which you get by putting aaPanel/nginx in front.`
}
`);
