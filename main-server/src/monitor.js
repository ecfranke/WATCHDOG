// Core logic: server registry + per-server tokens, up/down/reboot detection,
// threshold alerts with hysteresis, live history for charts, periodic health reports.
import crypto from "node:crypto";
import { esc, fmtClock, fmtDuration, metricsLine, nameHtml, statusMessage, worstDisk } from "./format.js";

const REBOOT_TOLERANCE = 60; // seconds of boot-time drift ignored (NTP adjustments)
const HISTORY_CAP = 5000;
const nowSec = () => Date.now() / 1000;

export const hashToken = (token) => crypto.createHash("sha256").update(String(token)).digest("hex");
const newToken = () => "wd_" + crypto.randomBytes(24).toString("base64url");

function slugify(name) {
  return (
    String(name)
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "server"
  );
}

export function historyPoint(ts, p) {
  return [
    Math.round(ts * 10) / 10,
    p.cpu?.percent ?? null,
    p.mem?.percent ?? null,
    p.temp?.max ?? null,
    p.net?.rx_rate ?? null,
    p.net?.tx_rate ?? null,
    worstDisk(p)?.percent ?? null,
  ];
}

export class Monitor {
  /**
   * @param cfg       config from loadConfig()
   * @param store     Store instance
   * @param notify    (text, important?) => void
   * @param broadcast (message) => void   — pushes to dashboard WebSocket clients
   */
  constructor(cfg, store, notify, broadcast) {
    this.cfg = cfg;
    this.store = store;
    this.notify = notify;
    this.broadcast = broadcast;
    this.startedAt = nowSec();
    this.runtime = new Map(); // id -> { history: [], alerts: {} }
    this.byToken = new Map(); // tokenHash -> id
    this.rules = [
      { key: "cpu", label: "High CPU", unit: "%", threshold: cfg.cpuAlert, duration: cfg.cpuAlertFor,
        measure: (p) => [p.cpu?.percent, ""] },
      { key: "ram", label: "High RAM", unit: "%", threshold: cfg.ramAlert, duration: cfg.ramAlertFor,
        measure: (p) => [p.mem?.percent, ""] },
      { key: "disk", label: "Disk almost full", unit: "%", threshold: cfg.diskAlert, duration: cfg.diskAlertFor,
        measure: (p) => { const d = worstDisk(p); return [d?.percent, d?.mount || ""]; } },
      { key: "temp", label: "High temperature", unit: "°C", threshold: cfg.tempAlert, duration: cfg.tempAlertFor,
        measure: (p) => [p.temp?.max, p.temp?.max_label || ""] },
    ].filter((r) => r.threshold > 0);

    for (const s of Object.values(store.servers)) {
      if (s.tokenHash) this.byToken.set(s.tokenHash, s.id);
    }
    console.log(`Loaded ${Object.keys(store.servers).length} server(s)`);
  }

  // ------------------------------------------------------------------ registry & tokens

  rt(id) {
    if (!this.runtime.has(id)) this.runtime.set(id, { history: [], alerts: {} });
    return this.runtime.get(id);
  }

  list() {
    return Object.values(this.store.servers).sort((a, b) => a.name.localeCompare(b.name));
  }

  get(id) {
    return this.store.servers[id] || null;
  }

  find(query) {
    const q = String(query || "").trim().toLowerCase();
    if (!q) return null;
    return this.store.servers[q] || this.list().find((s) => s.name.toLowerCase() === q) || null;
  }

  envSnippet(token) {
    return `MAIN_SERVER_URL=${this.cfg.publicUrl || "https://YOUR-MAIN-SERVER"}\nAGENT_TOKEN=${token}`;
  }

  addServer(rawName) {
    const name = String(rawName || "").trim().replace(/\s+/g, " ").slice(0, 40);
    if (!name) throw new Error("Give the server a name");
    if (this.list().some((s) => s.name.toLowerCase() === name.toLowerCase())) {
      throw new Error(`A server called "${name}" already exists`);
    }
    let id = slugify(name);
    for (let i = 2; this.store.servers[id]; i++) id = `${slugify(name)}-${i}`;
    const token = newToken();
    const s = {
      id, name, tokenHash: hashToken(token), tokenCreatedAt: nowSec(), createdAt: nowSec(),
      status: "pending", statusSince: nowSec(), lastSeen: null, bootTime: null, offlineReason: null,
      payload: null,
    };
    this.store.servers[id] = s;
    this.byToken.set(s.tokenHash, id);
    this.store.save();
    this.broadcast({ type: "update", server: this.summary(s) });
    return { server: s, token };
  }

  rotateToken(id) {
    const s = this.get(id);
    if (!s) throw new Error("Unknown server");
    if (s.tokenHash) this.byToken.delete(s.tokenHash);
    const token = newToken();
    s.tokenHash = hashToken(token);
    s.tokenCreatedAt = nowSec();
    this.byToken.set(s.tokenHash, id);
    this.store.save();
    this.broadcast({ type: "update", server: this.summary(s) });
    return token;
  }

  removeServer(id) {
    const s = this.get(id);
    if (!s) return false;
    if (s.tokenHash) this.byToken.delete(s.tokenHash);
    delete this.store.servers[id];
    this.runtime.delete(id);
    this.store.save();
    this.broadcast({ type: "removed", id });
    return true;
  }

  authenticate(token) {
    if (!token) return null;
    const id = this.byToken.get(hashToken(token));
    return id ? this.get(id) : null;
  }

  // ------------------------------------------------------------------ views

  summary(s) {
    const rt = this.rt(s.id);
    return {
      id: s.id,
      name: s.name,
      status: s.status,
      status_since: s.statusSince,
      last_seen: s.lastSeen,
      offline_reason: s.offlineReason,
      token_created_at: s.tokenCreatedAt,
      metrics: s.payload,
      alerts: Object.entries(rt.alerts)
        .filter(([, a]) => a.active)
        .map(([key, a]) => ({ key, label: a.label, unit: a.unit, value: a.value, since: a.since, detail: a.detail })),
    };
  }

  snapshot() {
    return this.list().map((s) => this.summary(s));
  }

  history(id) {
    return this.runtime.get(id)?.history || [];
  }

  activeAlerts() {
    const out = [];
    for (const s of this.list()) {
      if (s.status !== "online") continue;
      for (const a of Object.values(this.rt(s.id).alerts)) if (a.active) out.push([s, a]);
    }
    return out;
  }

  serverForText(s) {
    // format.js expects alerts on the object
    return { ...s, alerts: this.rt(s.id).alerts };
  }

  statusText(title) {
    return statusMessage(this.list().map((s) => this.serverForText(s)), title);
  }

  // ------------------------------------------------------------------ agent events

  handleReport(s, payload) {
    const now = nowSec();
    const prevStatus = s.status;
    const prevSince = s.statusSince;
    const prevBoot = s.bootTime;
    const boot = Number(payload.boot_time) || null;
    const rebooted = Boolean(prevBoot && boot && Math.abs(boot - prevBoot) > REBOOT_TOLERANCE);

    s.payload = payload;
    s.lastSeen = now;
    s.bootTime = boot;
    const rt = this.rt(s.id);
    rt.history.push(historyPoint(now, payload));
    const cutoff = now - this.cfg.historyMinutes * 60;
    while (rt.history.length && (rt.history[0][0] < cutoff || rt.history.length > HISTORY_CAP)) rt.history.shift();

    if (prevStatus === "pending") {
      this.notify(`🆕 ${nameHtml(s)} connected for the first time\n${metricsLine(payload)}`, true);
    } else if (prevStatus !== "online") {
      this.notify(
        `🟢 ${nameHtml(s)} is <b>back online</b>${rebooted ? " (rebooted)" : ""}\n` +
          `Was down for ${fmtDuration(prevSince ? now - prevSince : null)}\n${metricsLine(payload)}`,
        true,
      );
    } else if (rebooted) {
      this.notify(`🔄 ${nameHtml(s)} <b>rebooted</b> (up ${fmtDuration(payload.uptime)})\n${metricsLine(payload)}`, true);
    }
    if (prevStatus !== "online") {
      s.status = "online";
      s.statusSince = now;
      s.offlineReason = null;
    }

    this.evaluateAlerts(s, now);
    this.store.save();
    this.broadcast({ type: "update", server: this.summary(s), point: rt.history[rt.history.length - 1] });
  }

  handleGoodbye(s, reason) {
    if (s.status !== "online") return;
    const now = nowSec();
    s.status = "offline";
    s.statusSince = now;
    s.offlineReason = reason === "shutdown" ? "shutdown" : "agent_stopped";
    this.notify(
      s.offlineReason === "shutdown"
        ? `⏻ ${nameHtml(s)} is <b>shutting down / rebooting</b>`
        : `⏹ The agent on ${nameHtml(s)} was <b>stopped</b> — no more data from this server`,
      true,
    );
    this.store.save();
    this.broadcast({ type: "update", server: this.summary(s) });
  }

  checkOffline() {
    const now = nowSec();
    for (const s of this.list()) {
      if (s.status !== "online") continue;
      // after a main-server restart, give every sub server a fresh grace period
      const reference = Math.max(s.lastSeen || 0, this.startedAt);
      if (now - reference <= this.cfg.offlineAfter) continue;
      s.status = "offline";
      s.statusSince = s.lastSeen || now;
      s.offlineReason = "timeout";
      for (const a of Object.values(this.rt(s.id).alerts)) a.breachSince = null;
      this.notify(
        `🔴 ${nameHtml(s)} is <b>DOWN</b>\nNo response for ${fmtDuration(now - (s.lastSeen || now))} ` +
          `(last seen ${fmtClock(s.lastSeen)})`,
        true,
      );
      this.store.save();
      this.broadcast({ type: "update", server: this.summary(s) });
    }
  }

  evaluateAlerts(s, now) {
    const alerts = this.rt(s.id).alerts;
    for (const rule of this.rules) {
      const [value, detail] = rule.measure(s.payload || {});
      const st = (alerts[rule.key] ||= { label: rule.label, unit: rule.unit, active: false, breachSince: null });
      if (value === null || value === undefined) continue;
      st.value = value;
      st.detail = detail;
      const where = detail ? ` on ${esc(detail)}` : "";
      if (value >= rule.threshold) {
        st.breachSince ??= now;
        if (!st.active && now - st.breachSince >= rule.duration) {
          st.active = true;
          st.since = now;
          const held = rule.duration ? ` for ${fmtDuration(now - st.breachSince)}` : "";
          this.notify(
            `⚠️ ${nameHtml(s)}: <b>${rule.label}</b>${where}\n` +
              `${Math.round(value)}${rule.unit}${held} (limit ${rule.threshold}${rule.unit})`,
            true,
          );
        }
      } else if (value < rule.threshold - this.cfg.hysteresis) {
        st.breachSince = null;
        if (st.active) {
          const lasted = fmtDuration(now - (st.since || now));
          st.active = false;
          st.since = null;
          this.notify(
            `✅ ${nameHtml(s)}: ${rule.label.toLowerCase()} resolved${where}\nNow ${Math.round(value)}${rule.unit} (lasted ${lasted})`,
          );
        }
      } else if (!st.active) {
        st.breachSince = null; // inside the hysteresis band: restart the clock
      }
    }
  }

  // ------------------------------------------------------------------ timers

  start() {
    this.watchTimer = setInterval(() => {
      try {
        this.checkOffline();
      } catch (e) {
        console.error("offline check failed:", e);
      }
    }, 5000);

    const interval = this.cfg.reportIntervalMinutes * 60;
    if (interval > 0) {
      this.reportTimer = setInterval(() => {
        const now = nowSec();
        const last = Number(this.store.getKv("lastReportTs", 0));
        if (!last) return this.store.setKv("lastReportTs", now);
        if (now - last < interval) return;
        this.store.setKv("lastReportTs", now);
        if (this.list().length) this.notify(this.statusText("🩺 <b>Health report</b>"));
      }, 30_000);
    }
  }

  stop() {
    clearInterval(this.watchTimer);
    clearInterval(this.reportTimer);
  }
}
