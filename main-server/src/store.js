// Tiny JSON-file store: servers (with hashed tokens) and a few settings.
// Writes are debounced and atomic (write temp file, then rename).
import fs from "node:fs";
import path from "node:path";

export class Store {
  constructor(file) {
    this.file = file;
    this.data = { servers: {}, kv: {} };
    this.timer = null;
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    if (fs.existsSync(file)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
        this.data.servers = parsed.servers || {};
        this.data.kv = parsed.kv || {};
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
    return key in this.data.kv ? this.data.kv[key] : def;
  }

  setKv(key, value) {
    if (value === null || value === undefined) delete this.data.kv[key];
    else this.data.kv[key] = value;
    this.save();
  }

  save() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, 1000);
  }

  flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
}
