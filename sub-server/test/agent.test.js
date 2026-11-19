import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Collector } from "../src/collect.js";

const AGENT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "agent.js");
const run = (env, args = []) =>
  new Promise((resolve) =>
    execFile(process.execPath, [AGENT, ...args], { env: { ...process.env, WATCHDOG_ENV_FILE: "/nonexistent", ...env }, timeout: 15000 },
      (err, stdout, stderr) => resolve({ code: err?.code ?? 0, out: stdout + stderr })),
  );

test("a sample has the shape the main server expects", async () => {
  const c = new Collector();
  await c.init();
  const s = await c.collect();
  assert.equal(typeof s.cpu.percent, "number");
  assert.ok(s.cpu.percent >= 0 && s.cpu.percent <= 100);
  assert.ok(Array.isArray(s.cpu.per_core));
  assert.ok(s.mem.total > 0 && s.mem.percent >= 0 && s.mem.percent <= 100);
  assert.ok(Array.isArray(s.disks));
  for (const d of s.disks) assert.equal(typeof d.percent, "number");
  assert.ok(s.net.rx_rate >= 0 && s.net.tx_rate >= 0);
  assert.ok(s.uptime > 0 && s.boot_time > 1e9);
  assert.ok(s.temp === null || typeof s.temp.max === "number");
});

test("disk usage is cached between samples", async () => {
  const c = new Collector();
  await c.init();
  const a = await c.disks();
  assert.equal(await c.disks(), a); // same object: `df` didn't run again
});

test("bad settings stop the agent with a clear message", async () => {
  const bad = await run({ INTERVAL_SECONDS: "abc", MAIN_SERVER_URL: "http://x", AGENT_TOKEN: "wd_x" });
  assert.notEqual(bad.code, 0);
  assert.match(bad.out, /INTERVAL_SECONDS must be a number/);
  const missing = await run({ MAIN_SERVER_URL: "", AGENT_TOKEN: "" });
  assert.notEqual(missing.code, 0);
  assert.match(missing.out, /Set MAIN_SERVER_URL and AGENT_TOKEN/);
});
