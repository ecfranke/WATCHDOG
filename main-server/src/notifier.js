// Telegram notifications: queued (a slow Telegram API never blocks sub server reports),
// batched (events within a short window go out as one message, so 20 servers going down at once
// is one message, not 20), and split at Telegram's 4096-character limit.
import { splitMessage } from "./format.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const plain = (html) =>
  html.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");

export class Notifier {
  /**
   * @param api       grammY bot.api (can be set later)
   * @param batchMs   how long to collect events before sending them together
   */
  constructor(api, cfg, store, { batchMs = 2000 } = {}) {
    this.api = api;
    this.cfg = cfg;
    this.store = store;
    this.batchMs = batchMs;
    this.queue = [];
    this.running = null; // promise of the drain loop while it runs
  }

  mutedUntil() {
    return Number(this.store.getKv("muteUntil", 0)) || 0;
  }
  isMuted() {
    return this.mutedUntil() > Date.now() / 1000;
  }
  mute(minutes) {
    const until = Date.now() / 1000 + minutes * 60;
    this.store.setKv("muteUntil", until);
    return until;
  }
  unmute() {
    this.store.setKv("muteUntil", null);
  }

  /** Queue a message for every recipient. important=false sends it silently. */
  send(text, important = false) {
    if (this.isMuted()) {
      console.log("muted, dropping:", plain(text.split("\n")[0]));
      return;
    }
    if (this.queue.length >= 1000) return console.warn("notification queue full, dropping message");
    console.log("notify:", plain(text.split("\n")[0]));
    this.queue.push({ text, important });
    if (!this.running) this.running = this.drain().finally(() => (this.running = null));
  }

  /** Merge queued events into as few messages as possible. */
  takeBatch() {
    const items = this.queue.splice(0);
    const important = items.some((i) => i.important);
    return { parts: splitMessage(items.map((i) => i.text).join("\n\n")), important };
  }

  async drain() {
    while (this.queue.length) {
      if (this.batchMs) {
        // let related events arrive; flush() cuts the wait short
        await new Promise((r) => {
          const t = setTimeout(r, this.batchMs);
          this.wake = () => {
            clearTimeout(t);
            r();
          };
        });
        this.wake = null;
      }
      const { parts, important } = this.takeBatch();
      for (const chatId of this.cfg.recipients) {
        for (const part of parts) await this.deliver(chatId, part, important);
      }
    }
  }

  /** Wait (up to timeoutMs) for queued messages to go out — used before a restart. */
  async flush(timeoutMs = 5000) {
    this.batchMs = 0;
    this.wake?.();
    if (!this.running) return;
    let t;
    await Promise.race([this.running, new Promise((r) => (t = setTimeout(r, timeoutMs)))]);
    clearTimeout(t);
  }

  async deliver(chatId, text, important) {
    if (!this.api) return;
    let asPlain = false;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await this.api.sendMessage(chatId, asPlain ? plain(text) : text, {
          ...(asPlain ? {} : { parse_mode: "HTML" }),
          disable_notification: !important,
          link_preview_options: { is_disabled: true },
        });
        return true;
      } catch (e) {
        const code = e?.error_code;
        const desc = e?.description || e?.message || String(e);
        console.warn(`send to ${chatId} failed (attempt ${attempt}): ${desc}`);
        if (code === 400 && /parse entities|can't parse/i.test(desc) && !asPlain) {
          asPlain = true; // broken markup: still deliver the text
          continue;
        }
        if (code === 400 || code === 403) return false; // chat not found / bot blocked: retrying won't help
        const retryAfter = e?.parameters?.retry_after;
        await sleep(retryAfter ? (retryAfter + 1) * 1000 : 2000 * attempt);
      }
    }
    return false;
  }
}
