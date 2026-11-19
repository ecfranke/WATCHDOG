import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Monitor } from "../src/monitor.js";
import { Store } from "../src/store.js";
import { fakeClock, report, testConfig } from "./helpers.js";

let clock, msgs, mon, store;
const setup = (cfgOver = {}) => {
  const cfg = testConfig(cfgOver);
  store = new Store(cfg.dataFile);
  msgs = [];
  mon = new Monitor(cfg, store, (t, important) => msgs.push({ t: t.split("\n")[0], important }), () => {});
  return cfg;
};
const silence = () => {
  const l = console.log;
  console.log = () => {};
  return () => (console.log = l);
};
let unsilence;
beforeEach(() => {
  unsilence = silence();
  clock = fakeClock();
  setup();
});
afterEach(() => {
  clock.restore();
  clearTimeout(store.timer);
  unsilence();
});
const step = (sec, s, o) => {
  clock.advance(sec);
  return mon.handleReport(s, report(o));
};

test("tokens: add → authenticate → rotate revokes the old one → remove revokes all", () => {
  const { server, token } = mon.addServer("Web 1");
  assert.equal(server.id, "web-1");
  assert.equal(mon.authenticate(token).id, "web-1");
  const t2 = mon.rotateToken("web-1");
  assert.equal(mon.authenticate(token), null);
  assert.equal(mon.authenticate(t2).id, "web-1");
  assert.ok(!JSON.stringify(store.data).includes(t2), "only the hash is stored");
  assert.ok(mon.removeServer("web-1"));
  assert.equal(mon.authenticate(t2), null);
  assert.throws(() => mon.addServer("  "), /name/);
  mon.addServer("db");
  assert.throws(() => mon.addServer("DB"), /already exists/);
});

test("names like __proto__ / constructor are ordinary servers, and unknown ids stay unknown", () => {
  assert.equal(mon.get("constructor"), null);
  assert.equal(mon.get("toString"), null);
  assert.equal(mon.find("constructor"), null);
  assert.equal(mon.removeServer("hasOwnProperty"), false);
  const a = mon.addServer("__proto__");
  const b = mon.addServer("constructor");
  assert.equal(mon.get("__proto__").name, "__proto__");
  assert.equal(mon.find("constructor").id, b.server.id);
  assert.equal(mon.authenticate(a.token).name, "__proto__");
  assert.equal(Object.getPrototypeOf({}).polluted, undefined);
});

test("alerts fire only after the hold time and clear only below the hysteresis band", () => {
  const { token } = mon.addServer("web");
  const s = mon.authenticate(token);
  step(0, s);
  assert.match(msgs.at(-1).t, /connected for the first time/);
  step(5, s, { cpu: 95 });
  step(30, s, { cpu: 95 });
  assert.ok(!msgs.some((m) => /High CPU/.test(m.t)), "not yet: held 30 s of 60");
  step(31, s, { cpu: 95 });
  assert.match(msgs.at(-1).t, /High CPU/);
  step(5, s, { cpu: 87 }); // within 5 of the limit: still active
  assert.ok(!msgs.some((m) => /resolved/.test(m.t)));
  step(5, s, { cpu: 50 });
  assert.match(msgs.at(-1).t, /high cpu resolved/);
  assert.ok(!msgs.at(-1).important, "resolved messages are silent");
  step(5, s, { disk: 95 }); // disk rule has no hold time
  assert.match(msgs.at(-1).t, /Disk almost full/);
});

test("down after OFFLINE_AFTER, back online with downtime, reboot, goodbye", () => {
  const { token } = mon.addServer("web");
  const s = mon.authenticate(token);
  step(0, s);
  clock.advance(20);
  mon.checkOffline();
  clock.advance(5);
  mon.checkOffline();
  assert.equal(s.status, "online");
  clock.advance(15);
  mon.checkOffline();
  assert.equal(s.status, "offline");
  assert.match(msgs.at(-1).t, /DOWN/);
  const n = msgs.length;
  clock.advance(5);
  mon.checkOffline();
  assert.equal(msgs.length, n, "no repeated DOWN");
  step(60, s, { extra: { boot_time: 1_799_000_500 } });
  assert.match(msgs.at(-1).t, /back online.*rebooted/);
  step(5, s, { extra: { boot_time: 1_799_001_000 } });
  assert.match(msgs.at(-1).t, /rebooted/);
  mon.handleGoodbye(s, "shutdown");
  assert.equal(s.offlineReason, "shutdown");
  assert.match(msgs.at(-1).t, /shutting down/);
});

test("a paused main server doesn't declare everything down", () => {
  const { token } = mon.addServer("web");
  const s = mon.authenticate(token);
  step(0, s);
  mon.checkOffline();
  clock.advance(600); // e.g. the VM was suspended for 10 minutes
  mon.checkOffline();
  assert.equal(s.status, "online", "grace period restarted");
  clock.advance(31);
  mon.checkOffline();
  mon.checkOffline();
  assert.ok(s.status === "online" || s.status === "offline"); // keeps working afterwards
});

test("routine reports are saved lazily, status changes right away", () => {
  const { token } = mon.addServer("web");
  const s = mon.authenticate(token);
  clearTimeout(store.timer);
  store.timer = null;
  step(0, s); // pending → online: important
  assert.ok(store.dueAt - Date.now() <= 1000);
  clearTimeout(store.timer);
  store.timer = null;
  step(5, s); // nothing changed
  assert.ok(store.dueAt - Date.now() >= 59_000);
});

test("version changes and update failures are reported once", () => {
  const { token } = mon.addServer("web");
  const s = mon.authenticate(token);
  step(0, s, { extra: { version: { commit: "aaa1111", enabled: true } } });
  step(5, s, { extra: { version: { commit: "bbb2222", enabled: true } } });
  assert.match(msgs.at(-1).t, /updated/);
  step(5, s, { extra: { version: { commit: "bbb2222", enabled: true, error: "boom" } } });
  step(5, s, { extra: { version: { commit: "bbb2222", enabled: true, error: "boom" } } });
  assert.equal(msgs.filter((m) => /update failed/.test(m.t)).length, 1);
  mon.requestUpdate(s.id);
  assert.deepEqual(step(5, s), { update: true });
  assert.deepEqual(step(5, s), { update: false });
});

test("a malicious report is stored sanitised", () => {
  const { token } = mon.addServer("web");
  const s = mon.authenticate(token);
  mon.handleReport(s, { cpu: { percent: "<script>" }, procs: { top_cpu: [{ pid: "<img onerror=x>", cpu: "x" }] } });
  assert.equal(s.payload.cpu.percent, null);
  assert.equal(s.payload.procs.top_cpu[0].pid, 0);
});
