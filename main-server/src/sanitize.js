// Normalises a sub server report into a fixed shape before anything else sees it.
// Numbers are finite numbers (or null), strings are strings with a length limit, lists are capped.
// A buggy or compromised sub server can therefore neither break the dashboard nor inject markup.

const num = (v, min = -Infinity, max = Infinity) =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : null;
const int = (v, min = 0, max = Number.MAX_SAFE_INTEGER) => {
  const n = num(v, min, max);
  return n === null ? null : Math.round(n);
};
const str = (v, len = 64) => (v === null || v === undefined || typeof v === "object" ? null : String(v).slice(0, len));
const obj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : null);
const list = (v, max, fn) => (Array.isArray(v) ? v.slice(0, max).map(fn).filter((x) => x !== null) : []);
const pct = (v) => num(v, 0, 100);
const bytes = (v) => num(v, 0);

function proc(p) {
  p = obj(p);
  if (!p) return null;
  return { pid: int(p.pid) ?? 0, name: str(p.name, 40) ?? "?", cpu: num(p.cpu, 0, 100_000) ?? 0, mem: pct(p.mem) ?? 0 };
}

export function sanitizeVersion(v) {
  v = obj(v);
  if (!v) return null;
  return {
    app: str(v.app, 20),
    commit: str(v.commit, 12),
    branch: str(v.branch, 60),
    remote: str(v.remote, 200),
    enabled: v.enabled === true,
    auto: v.auto === true,
    reason: str(v.reason, 200),
    latest: str(v.latest, 12),
    last_check: num(v.last_check),
    error: str(v.error, 500),
    pending_restart: v.pending_restart === true,
  };
}

export function sanitizeReport(raw) {
  const p = obj(raw) || {};
  const cpu = obj(p.cpu) || {};
  const mem = obj(p.mem) || {};
  const swap = obj(p.swap) || {};
  const net = obj(p.net) || {};
  const dio = obj(p.diskio) || {};
  const temp = obj(p.temp);
  const procs = obj(p.procs);

  const sensors = temp
    ? list(temp.sensors, 16, (t) => {
        t = obj(t);
        const current = t && num(t.current, -50, 200);
        return current === null || current === undefined ? null : { chip: str(t.chip, 30) ?? "", label: str(t.label, 40) ?? "", current };
      })
    : [];
  const tempMax = temp ? num(temp.max, -50, 200) : null;

  const load = Array.isArray(cpu.load) ? cpu.load.slice(0, 3).map((x) => num(x, 0) ?? 0) : null;

  return {
    hostname: str(p.hostname, 100),
    os: str(p.os, 100),
    kernel: str(p.kernel, 100),
    arch: str(p.arch, 20),
    platform: str(p.platform, 20),
    cpu_model: str(p.cpu_model, 100),
    cpu: {
      percent: pct(cpu.percent),
      per_core: list(cpu.per_core, 512, (x) => pct(x) ?? 0),
      count: int(cpu.count, 0, 4096),
      load: load && load.length === 3 ? load : null,
      freq_mhz: num(cpu.freq_mhz, 0, 100_000),
    },
    mem: { total: bytes(mem.total), used: bytes(mem.used), available: bytes(mem.available), percent: pct(mem.percent) },
    swap: { total: bytes(swap.total), used: bytes(swap.used), percent: pct(swap.percent) },
    disks: list(p.disks, 32, (d) => {
      d = obj(d);
      const percent = d && pct(d.percent);
      if (percent === null || percent === undefined) return null;
      return { mount: str(d.mount, 120) ?? "?", device: str(d.device, 120), fstype: str(d.fstype, 20), total: bytes(d.total), used: bytes(d.used), percent };
    }),
    net: { rx_rate: bytes(net.rx_rate), tx_rate: bytes(net.tx_rate), rx_total: bytes(net.rx_total), tx_total: bytes(net.tx_total) },
    diskio: { read_rate: bytes(dio.read_rate), write_rate: bytes(dio.write_rate) },
    temp:
      tempMax === null && !sensors.length
        ? null
        : { max: tempMax ?? Math.max(...sensors.map((s) => s.current)), max_label: str(temp.max_label, 80) ?? "", sensors },
    procs: procs
      ? { count: int(procs.count) ?? 0, top_cpu: list(procs.top_cpu, 10, proc), top_mem: list(procs.top_mem, 10, proc) }
      : null,
    boot_time: num(p.boot_time, 0),
    uptime: num(p.uptime, 0),
    agent_version: str(p.agent_version, 20),
    interval: num(p.interval, 0.5, 3600),
    ts: num(p.ts),
  };
}
