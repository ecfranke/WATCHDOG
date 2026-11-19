import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { validateInitData } from "../src/telegramAuth.js";
import { sanitizeReport, sanitizeVersion } from "../src/sanitize.js";
import { splitMessage, esc, fmtDuration } from "../src/format.js";
import { Store } from "../src/store.js";
import { buildNginx, injectBlock, findConflicts } from "../scripts/nginx.js";
import { BOT_TOKEN, initData, tmpFile } from "./helpers.js";

// ------------------------------------------------------------------ Telegram login
test("initData: valid login is accepted", () => {
  assert.equal(validateInitData(initData(42), BOT_TOKEN).id, 42);
});
test("initData: tampered, foreign-bot, expired and empty logins are rejected", () => {
  assert.equal(validateInitData(initData(42).replace("first_name", "first_nam"), BOT_TOKEN), null);
  assert.equal(validateInitData(initData(42, { token: "999:other" }), BOT_TOKEN), null);
  assert.equal(validateInitData(initData(42, { authDate: Math.floor(Date.now() / 1000) - 2 * 86400 }), BOT_TOKEN), null);
  assert.equal(validateInitData("", BOT_TOKEN), null);
  assert.equal(validateInitData("hash=zz&user=%7B%7D", BOT_TOKEN), null);
});

// ------------------------------------------------------------------ report sanitising
test("sanitize: markup and junk in numeric fields can't reach the dashboard", () => {
  const evil = '<img src=x onerror="alert(1)">';
  const p = sanitizeReport({
    os: evil,
    cpu: { percent: evil, per_core: [evil, 50, 200], load: [evil, 1, 2], count: "8" },
    mem: { percent: 150 },
    disks: [{ mount: evil, percent: evil }, { mount: "/data", percent: 40 }],
    procs: { count: evil, top_cpu: [{ pid: evil, name: evil, cpu: evil, mem: "x" }] },
    temp: { max: evil, sensors: [{ chip: "cpu", label: "x", current: evil }, { chip: "cpu", label: "y", current: 61 }] },
    boot_time: evil,
  });
  assert.equal(p.cpu.percent, null);
  assert.deepEqual(p.cpu.per_core, [0, 50, 100]); // clamped to 0..100
  assert.deepEqual(p.cpu.load, [0, 1, 2]);
  assert.equal(p.cpu.count, null);
  assert.equal(p.mem.percent, 100);
  assert.equal(p.disks.length, 1); // the entry without a numeric percent is dropped
  assert.equal(p.procs.count, 0);
  assert.deepEqual(p.procs.top_cpu[0], { pid: 0, name: evil.slice(0, 40), cpu: 0, mem: 0 }); // string kept, escaped at display
  assert.equal(p.temp.max, 61); // falls back to the hottest valid sensor
  assert.equal(p.temp.sensors.length, 1);
  assert.equal(p.boot_time, null);
  assert.equal(typeof p.os, "string");
});
test("sanitize: lists are capped and non-objects tolerated", () => {
  const p = sanitizeReport({ disks: Array.from({ length: 500 }, (_, i) => ({ mount: `/m${i}`, percent: 1 })), cpu: "x", mem: null });
  assert.equal(p.disks.length, 32);
  assert.equal(p.cpu.percent, null);
  assert.equal(sanitizeReport(null).cpu.percent, null);
  assert.equal(sanitizeReport([1, 2]).disks.length, 0);
  assert.equal(sanitizeVersion("x"), null);
  assert.equal(sanitizeVersion({ commit: "a".repeat(100), enabled: "yes" }).commit.length, 12);
  assert.equal(sanitizeVersion({ enabled: "yes" }).enabled, false);
});

// ------------------------------------------------------------------ formatting
test("splitMessage keeps every part under the Telegram limit without cutting tags", () => {
  const text = Array.from({ length: 200 }, (_, i) => `🟢 <b>server-${i}</b> · up 1d\nCPU 1% · RAM 2%`).join("\n\n");
  const parts = splitMessage(text);
  assert.ok(parts.length > 1);
  for (const p of parts) {
    assert.ok(p.length <= 4000);
    assert.equal((p.match(/<b>/g) || []).length, (p.match(/<\/b>/g) || []).length);
  }
  assert.equal(parts.join("\n\n"), text);
  assert.deepEqual(splitMessage("short"), ["short"]);
  const huge = splitMessage(`<b>${"x".repeat(9000)}</b>`);
  assert.ok(huge.every((p) => p.length <= 4000 && !p.includes("<b>")));
});
test("esc and fmtDuration", () => {
  assert.equal(esc('<a href="x">&'), "&lt;a href=&quot;x&quot;&gt;&amp;");
  assert.equal(fmtDuration(90061), "1d 1h");
  assert.equal(fmtDuration(125), "2m 5s");
  assert.equal(fmtDuration(null), "?");
});

// ------------------------------------------------------------------ store
test("store: prototype-like ids are plain keys; corrupt file is set aside", () => {
  const file = tmpFile();
  const st = new Store(file);
  st.servers.__proto__ = { id: "__proto__" };
  st.servers.constructor = { id: "constructor" };
  st.flush();
  const again = new Store(file);
  assert.deepEqual(Object.keys(again.servers).sort(), ["__proto__", "constructor"]);
  assert.equal(again.getKv("toString"), null);

  fs.writeFileSync(file, "{not json");
  const recovered = new Store(file);
  assert.deepEqual(Object.keys(recovered.servers), []);
  assert.ok(fs.readdirSync(file.replace(/[^/]+$/, "")).some((f) => f.includes(".corrupt-")));
});
test("store: a failed write is logged, not thrown", () => {
  const st = new Store(tmpFile());
  st.file = "/proc/definitely/not/writable.json";
  const orig = console.error;
  console.error = () => {};
  try {
    assert.equal(st.flush(), false);
  } finally {
    console.error = orig;
    clearTimeout(st.timer);
  }
});
test("store: an earlier deadline wins over a later one", () => {
  const st = new Store(tmpFile());
  st.save(60_000);
  const late = st.dueAt;
  st.save(1000);
  assert.ok(st.dueAt < late);
  st.save(60_000);
  assert.ok(st.dueAt < late); // a later request doesn't push it back
  clearTimeout(st.timer);
});

// ------------------------------------------------------------------ nginx block
const AAPANEL_SITE = `server
{
    listen 443 ssl;
    server_name watchdog.example.com;
    #SSL-START
    ssl_certificate /x.pem;
    #SSL-END

    #REWRITE-START
    include /nonexistent/rewrite.conf;
    #REWRITE-END
    location ~ \\.well-known{ allow all; }
}
`;
test("nginx: block goes after #SSL-END, replaces itself, and removes cleanly", () => {
  const b1 = buildNginx({ port: 8080 });
  const once = injectBlock(AAPANEL_SITE, b1);
  assert.ok(once.indexOf("#SSL-END") < once.indexOf("proxy_pass http://127.0.0.1:8080"));
  const twice = injectBlock(once, buildNginx({ port: 9090 }));
  assert.equal((twice.match(/# ---- Watchdog main server/g) || []).length, 1);
  assert.ok(twice.includes("127.0.0.1:9090") && !twice.includes("127.0.0.1:8080"));
  // removing = injecting nothing; must give back the original file exactly
  const stripped = twice.replace(/\n?[ \t]*# ---- Watchdog main server[\s\S]*?# ---- end Watchdog ----[^\n]*\n/g, "");
  assert.equal(stripped, AAPANEL_SITE);
});
test("nginx: plain nginx config without aaPanel markers gets the block before the closing brace", () => {
  const out = injectBlock("server {\n  listen 443 ssl;\n}\n", buildNginx({ port: 7000 }));
  assert.ok(/proxy_pass http:\/\/127\.0\.0\.1:7000;[\s\S]*\n}\n$/.test(out));
});
test("nginx: an existing location / is reported as a conflict", () => {
  const site = AAPANEL_SITE.replace("#REWRITE-END", "#REWRITE-END\n    location /\n    {\n      root /x;\n    }");
  assert.equal(findConflicts(site, "watchdog.example.com").length, 1);
  assert.equal(findConflicts(injectBlock(AAPANEL_SITE, buildNginx({ port: 1 })), "watchdog.example.com").length, 0);
});
