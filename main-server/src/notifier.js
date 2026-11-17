// Queued Telegram notifications, so a slow Telegram API never blocks sub server reports.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Notifier {
  constructor(api, cfg, store) {
    this.api = api; // grammY bot.api
    this.cfg = cfg;
    this.store = store;
    this.queue = [];
    this.running = false;
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
      console.log("muted, dropping:", text.split("\n")[0]);
      return;
    }
    if (this.queue.length > 1000) return console.warn("notification queue full, dropping message");
    console.log("notify:", text.split("\n")[0].replace(/<[^>]+>/g, ""));
    this.queue.push({ text, important });
    this.drain();
  }

  async drain() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length) {
        const { text, important } = this.queue.shift();
        for (const chatId of this.cfg.recipients) await this.deliver(chatId, text, important);
      }
    } finally {
      this.running = false;
    }
  }

  async deliver(chatId, text, important) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await this.api.sendMessage(chatId, text, {
          parse_mode: "HTML",
          disable_notification: !important,
          link_preview_options: { is_disabled: true },
        });
        return;
      } catch (e) {
        const retryAfter = e?.parameters?.retry_after;
        console.warn(`send to ${chatId} failed (attempt ${attempt}): ${e.description || e.message}`);
        if (e?.error_code === 403 || e?.error_code === 400) return; // user blocked bot / chat not found
        await sleep(retryAfter ? (retryAfter + 1) * 1000 : 2000 * attempt);
      }
    }
  }
}
