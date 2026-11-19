// Shared test helpers (no extra dependencies: node:test + node:assert).
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const BOT_TOKEN = "123456789:AAtestTOKENtestTOKENtestTOKENtest12";

export function tmpFile(name = "watchdog.json") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wd-test-"));
  return path.join(dir, name);
}

/** A config object like loadConfig() returns, with test defaults. */
export function testConfig(over = {}) {
  return {
    botToken: BOT_TOKEN, adminIds: [42], alertChatIds: [], recipients: [42],
    webappUrl: "https://watchdog.example.com/app/", publicUrl: "https://watchdog.example.com",
    host: "127.0.0.1", port: 0, dataFile: tmpFile(), timezone: "",
    offlineAfter: 30, historyMinutes: 60, reportIntervalMinutes: 0,
    cpuAlert: 90, cpuAlertFor: 60, ramAlert: 90, ramAlertFor: 60, diskAlert: 90, diskAlertFor: 0,
    tempAlert: 80, tempAlertFor: 0, hysteresis: 5, devNoAuth: false,
    autoUpdate: false, updateCheckMinutes: 30, updateBranch: "", githubToken: "",
    ...over,
  };
}

/** Signed Telegram Mini App initData for a user id. */
export function initData(userId, { token = BOT_TOKEN, authDate = Math.floor(Date.now() / 1000) } = {}) {
  const p = new URLSearchParams({ auth_date: String(authDate), query_id: "AAH", user: JSON.stringify({ id: userId, first_name: "T" }) });
  const check = [...p.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join("\n");
  const secret = crypto.createHmac("sha256", "WebAppData").update(token).digest();
  p.set("hash", crypto.createHmac("sha256", secret).update(check).digest("hex"));
  return p.toString();
}

/** Controllable clock for Date.now(). */
export function fakeClock(start = 1_800_000_000_000) {
  const real = Date.now;
  let t = start;
  Date.now = () => t;
  return {
    advance: (sec) => (t += sec * 1000),
    restore: () => (Date.now = real),
  };
}

export function report(o = {}) {
  return {
    hostname: "web-1", os: "Ubuntu 24.04", boot_time: 1_799_000_000, uptime: 5000,
    cpu: { percent: o.cpu ?? 10, per_core: [10, 20], count: 2, load: [0.1, 0.2, 0.3] },
    mem: { total: 8e9, used: 4e9, available: 4e9, percent: o.ram ?? 50 },
    disks: [{ mount: "/", total: 1e11, used: 5e10, percent: o.disk ?? 50 }],
    temp: o.temp === undefined ? { max: 50, max_label: "cpu Package", sensors: [{ chip: "cpu", label: "Package", current: 50 }] } : o.temp,
    net: { rx_rate: 100, tx_rate: 50 },
    ...o.extra,
  };
}
