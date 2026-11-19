// Tiny JSON-file store: servers (with hashed tokens) and a few settings.
// Writes are debounced and atomic (write a temp file, then rename).
import fs from "node:fs";
import path from "node:path";

// Objects without a prototype, so ids like "__proto__" or "constructor" are plain keys.
const dict = (src) => Object.assign(Object.create(null), src && typeof src === "object" ? src : {});

export class Store {
  constructor(file) {
    this.file = file;
    this.data = { servers: dict(), kv: dict() };
    this.timer = null;
    this.dueAt = 0;
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    if (fs.existsSync(file)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
        this.data.servers = dict(parsed.servers);
        this.data.kv = dict(parsed.kv);
      } catch (e) {
        const backup = `${file}.corrupt-${Date.now()}`;
        fs.renameSync(file, backup);
        console.error(`Could not read ${file} (${e.message}); moved it to ${backup} and started fresh`);
      }
    }
  }

  get servers() {
    return this.data.servers;
  }

  getKv(key, def = null) {
    return Object.hasOwn(this.data.kv, key) ? this.data.kv[key] : def;
  }

  setKv(key, value) {
    if (value === null || value === undefined) delete this.data.kv[key];
    else this.data.kv[key] = value;
    this.save();
  }

  /**
   * Schedule a write. Important changes use the default 1 s; routine metric updates pass a longer
   * delay so the file isn't rewritten on every report. An earlier deadline always wins.
   */
  save(delayMs = 1000) {
    const due = Date.now() + delayMs;
    if (this.timer && this.dueAt <= due) return;
    clearTimeout(this.timer);
    this.dueAt = due;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, delayMs);
    this.timer.unref?.();
  }

  flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const tmp = `${this.file}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
      return true;
    } catch (e) {
      // disk full / permissions: keep running on the in-memory state and try again later
      console.error(`Could not save ${this.file}: ${e.message}`);
      this.save(30_000);
      return false;
    }
  }
}
