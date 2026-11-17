#!/usr/bin/env node
// Watchdog sub server — sends this machine's metrics to the main server every few seconds.
//
// Configure in .env (next to package.json):
//   MAIN_SERVER_URL=https://watchdog.example.com
//   AGENT_TOKEN=wd_...            (from the main server: /add <name> in Telegram)
//   INTERVAL_SECONDS=5
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

async function main() {
  const collector = new Collector();
  await collector.init();

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
  await sleep(1000); // let CPU counters accumulate
  let failures = 0;
  let registeredAs = null;

  while (!stopping) {
    const started = Date.now();
    let wait = INTERVAL;
    try {
      const sample = await collector.collect();
      const res = await post("/api/agent/report", { ...sample, agent_version: VERSION, interval: INTERVAL / 1000, ts: Date.now() / 1000 });
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
