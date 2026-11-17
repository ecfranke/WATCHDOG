// Main server configuration, read from .env
import dotenv from "dotenv";

dotenv.config({ path: process.env.WATCHDOG_ENV_FILE || ".env", quiet: true });

const str = (name, def = "") => (process.env[name] ?? def).toString().trim();
const num = (name, def) => {
  const raw = str(name);
  if (!raw) return def;
  const n = Number(raw);
  if (Number.isNaN(n)) throw new Error(`${name} must be a number`);
  return n;
};
const bool = (name, def = false) => {
  const raw = str(name).toLowerCase();
  return raw ? ["1", "true", "yes", "on"].includes(raw) : def;
};
const ids = (name) =>
  str(name)
    .split(/[,;\s]+/)
    .filter(Boolean)
    .map((x) => {
      const n = Number(x);
      if (!Number.isInteger(n)) throw new Error(`${name}: "${x}" is not a Telegram ID`);
      return n;
    });

export function loadConfig() {
  const webappUrl = str("WEBAPP_URL").replace(/\/+$/, "/");
  let publicUrl = str("PUBLIC_URL").replace(/\/+$/, "");
  if (!publicUrl && webappUrl) {
    try {
      publicUrl = new URL(webappUrl).origin;
    } catch {
      /* ignore */
    }
  }

  const cfg = {
    botToken: str("BOT_TOKEN"),
    adminIds: ids("ADMIN_IDS"),
    alertChatIds: ids("ALERT_CHAT_IDS"),
    webappUrl,
    publicUrl, // what sub servers use as MAIN_SERVER_URL
    host: str("HOST", "0.0.0.0"),
    port: num("PORT", 8080),
    dataFile: str("DATA_FILE", "data/watchdog.json"),

    offlineAfter: num("OFFLINE_AFTER_SECONDS", 30),
    historyMinutes: num("HISTORY_MINUTES", 60),
    reportIntervalMinutes: num("HEALTH_REPORT_INTERVAL_MINUTES", 360),

    cpuAlert: num("CPU_ALERT_PERCENT", 90),
    cpuAlertFor: num("CPU_ALERT_FOR_SECONDS", 120),
    ramAlert: num("RAM_ALERT_PERCENT", 90),
    ramAlertFor: num("RAM_ALERT_FOR_SECONDS", 120),
    diskAlert: num("DISK_ALERT_PERCENT", 90),
    diskAlertFor: num("DISK_ALERT_FOR_SECONDS", 0),
    tempAlert: num("TEMP_ALERT_CELSIUS", 80),
    tempAlertFor: num("TEMP_ALERT_FOR_SECONDS", 60),
    hysteresis: num("ALERT_HYSTERESIS", 5),

    devNoAuth: bool("DEV_NO_AUTH", false),
  };

  cfg.recipients = [...new Set([...cfg.adminIds, ...cfg.alertChatIds])];

  const problems = [];
  if (!cfg.botToken) problems.push("BOT_TOKEN is not set (get one from @BotFather)");
  if (!cfg.adminIds.length) problems.push("ADMIN_IDS is empty (send /start to your bot to see your Telegram ID)");
  if (problems.length) {
    console.error("Watchdog config error:\n  - " + problems.join("\n  - "));
    process.exit(1);
  }
  if (!cfg.publicUrl) {
    console.warn("PUBLIC_URL / WEBAPP_URL not set: .env snippets for sub servers will show a placeholder URL");
  }
  return cfg;
}
