#!/usr/bin/env node
// Watchdog sub server — sends this machine's metrics to the main server every few seconds.
//
// Configure in .env (next to package.json):
//   MAIN_SERVER_URL=https://watchdog.example.com
//   AGENT_TOKEN=wd_...            (from the main server: /add <name> in Telegram)
//   INTERVAL_SECONDS=5
//   AUTO_UPDATE=true              pull new versions from GitHub (needs a git clone, see install.sh)
//   UPDATE_CHECK_MINUTES=30
//   UPDATE_BRANCH=                default: the checked-out branch
//   UPDATE_GITHUB_TOKEN=                 only for a private repository
//
//   npm start            run
//   npm run check        print one sample and exit
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { Collector } from "./collect.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
  } catch {
    return "unknown";
  }
})();
const ENV_FILE = process.env.WATCHDOG_ENV_FILE || path.join(ROOT, ".env");
dotenv.config({ path: ENV_FILE, quiet: true });

const cleanUrl = (u) => String(u || "").trim().replace(/\/+$/, "");
let MAIN = cleanUrl(process.env.MAIN_SERVER_URL);
let TOKEN = (process.env.AGENT_TOKEN || "").trim();
const intervalSec = Number(process.env.INTERVAL_SECONDS || 5);
if (!Number.isFinite(intervalSec) || intervalSec < 1 || intervalSec > 3600) {
  console.error(`INTERVAL_SECONDS must be a number between 1 and 3600 (got "${process.env.INTERVAL_SECONDS}")`);
  process.exit(1);
}
const INTERVAL = intervalSec * 1000;
const MAX_BACKOFF = 30_000; // while the main server is unreachable, retry at most every 30 s
const ONCE = process.argv.includes("--once");
const AUTO_UPDATE = !["0", "false", "no", "off"].includes(String(process.env.AUTO_UPDATE ?? "true").toLowerCase());

const log = (...a) => console.log(new Date().toISOString(), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function post(pathname, body, timeoutMs = 10_000) {
  const res = await fetch(MAIN + pathname, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TOKEN}`,
      "User-Agent": `watchdog-sub-server/${VERSION}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

/** True when systemd says the whole machine is going down (reboot / poweroff). */
function systemShuttingDown() {
  return new Promise((resolve) => {
    execFile("systemctl", ["is-system-running"], { timeout: 2000 }, (err, stdout) =>
      resolve(String(stdout || "").trim() === "stopping"),
    );
  });
}

/** Auto-update helper from ../../shared (present when installed from a git clone). */
async function loadUpdater() {
  let mod;
  try {
    mod = await import("../../shared/updater.js");
  } catch {
    return { updater: null, isSupervised: () => false };
  }
  const updater = await mod.createUpdater({
    component: "sub-server",
    appDir: ROOT,
    branch: process.env.UPDATE_BRANCH || undefined,
    auto: AUTO_UPDATE,
    intervalMinutes: Number(process.env.UPDATE_CHECK_MINUTES || 30),
    githubToken: process.env.UPDATE_GITHUB_TOKEN || "",
    log,
  });
  return { updater, isSupervised: mod.isSupervised };
}

async function main() {
  const collector = new Collector();
  await collector.init();
  const { updater, isSupervised } = await loadUpdater();
  const versionInfo = () =>
    updater ? { app: VERSION, ...updater.info() } : { app: VERSION, enabled: false, reason: "shared/updater.js not found" };

  if (ONCE) {
    await sleep(1000);
    console.log(JSON.stringify(await collector.collect(), null, 2));
    return;
  }
  if (!MAIN || !TOKEN || TOKEN.includes("paste_your_token")) {
    console.error("Set MAIN_SERVER_URL and AGENT_TOKEN in .env (get the token from the main server: /add <name>)");
    process.exit(1);
  }
  if (/^http:\/\//i.test(MAIN) && !/^http:\/\/(localhost|127\.|\[::1\])/i.test(MAIN)) {
    log("⚠ MAIN_SERVER_URL uses plain http: the token travels unencrypted. Use https:// (aaPanel SSL).");
  }

  // After a rejected token, pick up a new AGENT_TOKEN / MAIN_SERVER_URL from .env without a restart.
  const reloadEnv = () => {
    try {
      const env = dotenv.parse(fs.readFileSync(ENV_FILE));
      const token = (env.AGENT_TOKEN || "").trim();
      const main = cleanUrl(env.MAIN_SERVER_URL);
      if ((token && token !== TOKEN) || (main && main !== MAIN)) {
        TOKEN = token || TOKEN;
        MAIN = main || MAIN;
        log("Loaded new settings from .env");
        return true;
      }
    } catch {
      /* .env not readable: keep the current settings */
    }
    return false;
  };

  let stopping = false;
  let wake = null;

  // Install an update (automatic, or requested from the main server) and restart onto it.
  const applyUpdate = async (why) => {
    if (!updater?.enabled) return log(`Update requested but unavailable: ${updater?.reason || "no updater"}`);
    try {
      const r = await updater.update();
      if (r.status === "up-to-date") return log(`Update check (${why}): already up to date (${updater.info().commit})`);
      if (r.status === "busy") return;
      restartAfterUpdate(r);
    } catch (e) {
      log(`Update failed: ${e.message}`);
    }
  };
  function restartAfterUpdate(r) {
    if (r.status === "updated") return log(`Updated ${r.from} → ${r.to} (no sub-server changes, no restart needed)`);
    if (isSupervised()) {
      log(`Updated ${r.from} → ${r.to}, restarting…`);
      stopping = true; // exit without "goodbye": we're back within seconds, so no down alert
      wake?.();
      setTimeout(() => process.exit(0), 200);
    } else {
      log(`Updated ${r.from} → ${r.to}. Restart the agent to run the new version.`);
    }
  }
  const stop = async (signal) => {
    if (stopping) return;
    stopping = true;
    wake?.();
    const reason = signal === "SIGTERM" && (await systemShuttingDown()) ? "shutdown" : "agent_stopped";
    try {
      await post("/api/agent/goodbye", { reason }, 3000);
      log(`Told the main server we're going offline (${reason})`);
    } catch (e) {
      log(`Could not notify the main server on exit: ${e.message}`);
    }
    process.exit(0);
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));

  log(`Reporting to ${MAIN} every ${INTERVAL / 1000}s`);
  if (updater?.enabled) {
    log(`Auto-update ${AUTO_UPDATE ? "on" : "off"}: ${updater.remote} (${updater.branch}) @ ${updater.info().commit}`);
    updater.start(
      (r) => restartAfterUpdate(r),
      (e) => log(`Auto-update: ${e.message}`),
    );
  } else {
    log(`Auto-update off: ${updater?.reason || "shared/updater.js not found"}`);
  }
  await sleep(1000); // let CPU counters accumulate
  let failures = 0;
  let registeredAs = null;

  while (!stopping) {
    const started = Date.now();
    let wait = INTERVAL;
    let sample;
    try {
      sample = await collector.collect();
    } catch (e) {
      log(`Collecting metrics failed: ${e.message}`);
      await sleep(INTERVAL);
      continue;
    }
    try {
      const res = await post("/api/agent/report", {
        ...sample, agent_version: VERSION, version: versionInfo(), interval: INTERVAL / 1000, ts: Date.now() / 1000,
      });
      if (res.update) applyUpdate("requested by the main server");
      if (registeredAs !== res.name) {
        log(`Connected — this server is "${res.name}" on the main server`);
        registeredAs = res.name;
      } else if (failures) {
        log("Connection to the main server restored");
      }
      failures = 0;
    } catch (e) {
      failures++;
      if (e.status === 401) {
        if (reloadEnv()) {
          wait = 1000; // try the new token right away
        } else {
          if (failures === 1 || failures % 10 === 0) {
            log("The main server rejected AGENT_TOKEN (wrong or revoked). Get a new one with /token <name> and put it in .env");
          }
          wait = 10_000; // re-check .env every 10 s, so a pasted new token is picked up quickly
        }
      } else {
        if (failures === 1 || failures % 12 === 0) {
          log(`Cannot reach the main server (attempt ${failures}): ${e.cause?.code || e.message}`);
        }
        wait = Math.min(MAX_BACKOFF, INTERVAL * 2 ** Math.min(failures - 1, 5));
      }
    }
    if (stopping) break;
    await new Promise((r) => {
      wake = r;
      setTimeout(r, Math.max(500, wait - (Date.now() - started)));
    });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
