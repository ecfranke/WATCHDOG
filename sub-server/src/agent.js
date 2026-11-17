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
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { Collector } from "./collect.js";

const VERSION = "2.0.0";
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: process.env.WATCHDOG_ENV_FILE || path.join(ROOT, ".env"), quiet: true });

const MAIN = (process.env.MAIN_SERVER_URL || "").trim().replace(/\/+$/, "");
const TOKEN = (process.env.AGENT_TOKEN || "").trim();
const INTERVAL = Math.max(1, Number(process.env.INTERVAL_SECONDS || 5)) * 1000;
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
    try {
      const sample = await collector.collect();
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
        log("The main server rejected AGENT_TOKEN (wrong or revoked). Get a new one with /token <name> and update .env");
        wait = 60_000;
      } else if (failures === 1 || failures % 12 === 0) {
        log(`Cannot reach the main server (attempt ${failures}): ${e.cause?.code || e.message}`);
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
