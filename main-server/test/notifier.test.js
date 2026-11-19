import { test } from "node:test";
import assert from "node:assert/strict";
import { Notifier } from "../src/notifier.js";
import { Store } from "../src/store.js";
import { testConfig } from "./helpers.js";

const quiet = async (fn) => {
  const [l, w] = [console.log, console.warn];
  console.log = console.warn = () => {};
  try {
    return await fn();
  } finally {
    console.log = l;
    console.warn = w;
  }
};
const make = (api, over = {}) => new Notifier(api, testConfig({ recipients: [42], ...over }), new Store(testConfig().dataFile), { batchMs: 20 });

test("a burst of events becomes one message; important if any event was", () =>
  quiet(async () => {
    const sent = [];
    const n = make({ sendMessage: async (chat, text, opt) => sent.push({ chat, text, opt }) });
    for (let i = 0; i < 20; i++) n.send(`🔴 server-${i} is DOWN`, i === 3);
    await n.running;
    assert.equal(sent.length, 1);
    assert.equal(sent[0].text.split("\n\n").length, 20);
    assert.equal(sent[0].opt.disable_notification, false);
  }));

test("messages over 4096 characters are split", () =>
  quiet(async () => {
    const sent = [];
    const n = make({ sendMessage: async (chat, text) => sent.push(text) });
    for (let i = 0; i < 150; i++) n.send(`🟢 <b>server-${i}</b> · up 3d\nCPU 1% · RAM 2% · Disk 3% (/)`);
    await n.running;
    assert.ok(sent.length >= 2);
    assert.ok(sent.every((t) => t.length <= 4096));
  }));

test("broken HTML is resent as plain text; 403 isn't retried; muted drops", () =>
  quiet(async () => {
    const calls = [];
    const n = make({
      sendMessage: async (chat, text, opt) => {
        calls.push({ chat, text, opt });
        if (chat === 42 && opt.parse_mode) throw { error_code: 400, description: "Bad Request: can't parse entities" };
        if (chat === 7) throw { error_code: 403, description: "Forbidden: bot was blocked by the user" };
      },
    }, { recipients: [42, 7] });
    n.send("<b>broken & <i>tags");
    await n.running;
    assert.equal(calls.filter((c) => c.chat === 42).length, 2);
    assert.equal(calls.find((c) => c.chat === 42 && !c.opt.parse_mode).text, "broken & tags");
    assert.equal(calls.filter((c) => c.chat === 7).length, 1);

    n.mute(10);
    n.send("hidden");
    assert.equal(n.queue.length, 0);
    n.unmute();
    assert.equal(n.isMuted(), false);
  }));

test("flush waits for queued messages", () =>
  quiet(async () => {
    const sent = [];
    const n = make({ sendMessage: async (c, t) => sent.push(t) });
    n.batchMs = 10_000; // would normally wait 10 s
    n.send("restarting…");
    const t0 = Date.now();
    await n.flush(3000);
    assert.equal(sent.length, 1, "sent before the flush returned");
    assert.ok(Date.now() - t0 < 1000, "without waiting out the batch window");
  }));
