import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { createServer } from "../src/server.js";
import { Monitor } from "../src/monitor.js";
import { Notifier } from "../src/notifier.js";
import { Store } from "../src/store.js";
import { initData, report, testConfig } from "./helpers.js";

let base, http, mon, store, origLog;
before(async () => {
  origLog = console.log;
  console.log = () => {};
  const cfg = testConfig();
  store = new Store(cfg.dataFile);
  const notifier = new Notifier(null, cfg, store, { batchMs: 0 });
  let broadcast = () => {};
  mon = new Monitor(cfg, store, () => {}, (m) => broadcast(m));
  http = createServer(cfg, mon, notifier, async () => ({ status: "up-to-date" }));
  broadcast = http.broadcast;
  await new Promise((r) => http.server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${http.server.address().port}`;
});
after(async () => {
  await http.close();
  clearTimeout(store.timer);
  console.log = origLog;
});

const admin = { "X-Telegram-Init-Data": initData(42), "Content-Type": "application/json" };
const post = (path, body, headers) => fetch(base + path, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });

test("dashboard API: login checks", async () => {
  assert.equal((await fetch(`${base}/api/servers`)).status, 401);
  assert.equal((await fetch(`${base}/api/servers`, { headers: { "X-Telegram-Init-Data": initData(7) } })).status, 403);
  assert.equal((await fetch(`${base}/api/servers`, { headers: admin })).status, 200);
  assert.equal((await fetch(`${base}/api/servers/constructor/history`, { headers: admin })).status, 404);
});

test("agent API: token, sanitising, malformed JSON", async () => {
  const r = await (await post("/api/servers", { name: "web-1" }, admin)).json();
  assert.match(r.token, /^wd_/);
  assert.match(r.env, /AGENT_TOKEN=wd_/);
  const agent = { Authorization: `Bearer ${r.token}`, "Content-Type": "application/json" };

  assert.equal((await post("/api/agent/report", report(), { ...agent, Authorization: "Bearer wd_nope" })).status, 401);
  const ok = await post("/api/agent/report", report({ extra: { cpu: { percent: "<b>x</b>" } } }), agent);
  assert.equal(ok.status, 200);
  assert.equal(mon.get("web-1").payload.cpu.percent, null);

  const bad = await post("/api/agent/report", "{not json", agent);
  assert.equal(bad.status, 400);
  assert.match(bad.headers.get("content-type"), /json/);
});

// Messages are buffered from the moment the socket opens, so none is missed while a test awaits something else.
const openWs = (path = "/ws") =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(base.replace("http", "ws") + path);
    ws.inbox = [];
    ws.waiters = [];
    const deliver = (item) => {
      const w = ws.waiters.shift();
      if (w) w(item);
      else ws.inbox.push(item);
    };
    ws.on("message", (m) => deliver({ msg: JSON.parse(m) }));
    ws.on("close", (code) => deliver({ code }));
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
const nextMessage = (ws) =>
  ws.inbox.length ? Promise.resolve(ws.inbox.shift()) : new Promise((resolve) => ws.waiters.push(resolve));

test("websocket: login as the first message, live updates, rejection codes", async () => {
  const ws = await openWs();
  ws.send(JSON.stringify({ type: "auth", initData: initData(42) }));
  const snap = (await nextMessage(ws)).msg;
  assert.equal(snap.type, "snapshot");

  const r = await (await post("/api/servers", { name: "live-1" }, admin)).json();
  const upd = (await nextMessage(ws)).msg;
  assert.equal(upd.type, "update");
  assert.equal(upd.server.name, "live-1");
  await post("/api/agent/report", report(), { Authorization: `Bearer ${r.token}`, "Content-Type": "application/json" });
  const live = (await nextMessage(ws)).msg;
  assert.ok(live.point && live.server.status === "online");
  ws.close();

  const stranger = await openWs();
  stranger.send(JSON.stringify({ type: "auth", initData: initData(7) }));
  assert.equal((await nextMessage(stranger)).code, 4403);

  const noAuth = await openWs();
  noAuth.send("ping"); // ignored before login
  noAuth.send(JSON.stringify({ type: "hello" }));
  assert.equal((await nextMessage(noAuth)).code, 4401);

  const legacy = await openWs(`/ws?initData=${encodeURIComponent(initData(42))}`);
  assert.equal((await nextMessage(legacy)).msg.type, "snapshot");
  legacy.close();

  await assert.rejects(openWs(`/ws?initData=bad`)); // refused at the HTTP upgrade
});

test("websocket: oversized client messages are refused", async () => {
  const ws = await openWs();
  ws.send("x".repeat(64 * 1024));
  assert.equal((await nextMessage(ws)).code, 1009);
});
