// Formatting helpers for Telegram messages (HTML parse mode)

export const esc = (s) =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

export function fmtDuration(sec) {
  if (sec === null || sec === undefined || Number.isNaN(sec)) return "?";
  sec = Math.max(0, Math.floor(sec));
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return m < 10 ? `${m}m ${s}s` : `${m}m`;
  return `${s}s`;
}

export function fmtBytes(n) {
  if (n === null || n === undefined) return "?";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (Math.abs(n) >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return i === 0 ? `${Math.round(n)} B` : `${n.toFixed(1)} ${units[i]}`;
}

let timeZone; // undefined = the machine's time zone

/** Use this IANA time zone (e.g. "America/Toronto") for times shown in Telegram. Returns false if unknown. */
export function setTimezone(tz) {
  if (!tz) return true;
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: tz });
    timeZone = tz;
    return true;
  } catch {
    return false;
  }
}

export function fmtClock(ts) {
  if (!ts) return "never";
  return new Date(ts * 1000).toLocaleTimeString("en-GB", { hour12: false, timeZone });
}

export function fmtDateTime(ts) {
  if (!ts) return "never";
  return new Date(ts * 1000).toLocaleString("en-GB", { hour12: false, timeZone, dateStyle: "medium", timeStyle: "short" });
}

export const TELEGRAM_LIMIT = 4096;

/**
 * Split a Telegram HTML message into parts under the limit, at blank lines, then at line breaks.
 * Every formatting tag in this app opens and closes on one line, so tags are never cut in half.
 */
export function splitMessage(text, limit = TELEGRAM_LIMIT - 96) {
  if (text.length <= limit) return [text];
  const parts = [];
  let cur = "";
  const push = () => {
    if (cur) parts.push(cur);
    cur = "";
  };
  const add = (piece, sep) => {
    if (!cur) cur = piece;
    else if (cur.length + sep.length + piece.length <= limit) cur += sep + piece;
    else {
      push();
      cur = piece;
    }
  };
  for (const block of text.split("\n\n")) {
    if (block.length <= limit) {
      add(block, "\n\n");
      continue;
    }
    for (const line of block.split("\n")) {
      if (line.length <= limit) add(line, "\n");
      else {
        // one enormous line: drop its markup and cut it hard
        const plain = line.replace(/<[^>]+>/g, "");
        for (let i = 0; i < plain.length; i += limit) add(plain.slice(i, i + limit), "\n");
      }
    }
  }
  push();
  return parts;
}

export const nameHtml = (s) => `<b>${esc(s.name)}</b>`;

export function worstDisk(p) {
  const disks = (p && p.disks) || [];
  if (!disks.length) return null;
  return disks.reduce((a, b) => (b.percent > a.percent ? b : a));
}

export function metricsLine(p) {
  if (!p) return "no data yet";
  const parts = [];
  if (p.cpu?.percent != null) parts.push(`CPU ${Math.round(p.cpu.percent)}%`);
  if (p.mem?.percent != null) parts.push(`RAM ${Math.round(p.mem.percent)}%`);
  const d = worstDisk(p);
  if (d) parts.push(`Disk ${Math.round(d.percent)}% (${esc(d.mount)})`);
  if (p.temp?.max != null) parts.push(`🌡 ${Math.round(p.temp.max)}°C`);
  return parts.length ? parts.join(" · ") : "no data yet";
}

export function serverBlock(s, now = Date.now() / 1000) {
  if (s.status === "pending") {
    return `⚪ ${nameHtml(s)} · waiting for the sub server to connect`;
  }
  if (s.status === "online") {
    let out = `🟢 ${nameHtml(s)} · up ${fmtDuration(s.payload?.uptime)}\n${metricsLine(s.payload)}`;
    const active = Object.values(s.alerts || {}).filter((a) => a.active);
    if (active.length) out += "\n⚠️ " + active.map((a) => esc(a.label)).join(", ");
    return out;
  }
  const reason =
    s.offlineReason === "shutdown" ? " (shut down)" : s.offlineReason === "agent_stopped" ? " (agent stopped)" : "";
  return `🔴 ${nameHtml(s)} · offline ${fmtDuration(now - (s.statusSince || now))}${reason}\nlast seen ${fmtClock(s.lastSeen)}`;
}

export function statusMessage(servers, title = "📊 <b>Server status</b>") {
  if (!servers.length) {
    return `${title}\n\nNo servers yet. Add one with /add &lt;name&gt; and put the token in the sub server's .env.`;
  }
  const now = Date.now() / 1000;
  const online = servers.filter((s) => s.status === "online").length;
  const rank = { offline: 0, online: 1, pending: 2 };
  const ordered = [...servers].sort((a, b) => rank[a.status] - rank[b.status] || a.name.localeCompare(b.name));
  const lines = [`${title} — ${online}/${servers.length} online`, ""];
  for (const s of ordered) lines.push(serverBlock(s, now), "");
  lines.push(`<i>Updated ${fmtClock(now)}</i>`);
  return lines.join("\n");
}
