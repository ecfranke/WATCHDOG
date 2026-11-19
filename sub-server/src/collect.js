// Collects system metrics with the `systeminformation` package.
import os from "node:os";
import si from "systeminformation";

const SKIP_FS = new Set(["squashfs", "tmpfs", "devtmpfs", "overlay", "iso9660", "autofs", "devfs", "nullfs", "ramfs", "efivarfs", "fuse.rclone", "fuse.gvfsd-fuse", "fuse.portal", "fuse.snapfuse", "fuse.lxcfs"]);
const SKIP_MOUNT = /^(\/snap|\/boot\/efi|\/var\/lib\/docker|\/run|\/sys|\/proc|\/dev|\/System\/Volumes\/(VM|Preboot|Update|xarts|iSCPreboot|Hardware))/;
const SKIP_NIC = /^(lo|veth|docker|br-|virbr|cni|flannel|cali|tun|utun|awdl|llw|anpi|ap\d|bridge)/i;
const PROCESS_EVERY_MS = 15_000; // process list is the expensive part
const DISKS_EVERY_MS = 30_000; // disk usage changes slowly; `df` needn't run every few seconds
const round1 = (n) => (n === null || n === undefined || Number.isNaN(n) ? null : Math.round(n * 10) / 10);
const valid = (t) => typeof t === "number" && t > 0 && t < 150;

export class Collector {
  constructor() {
    this.last = null; // { t, rx, tx, rd, wr }
    this.procs = null;
    this.procsAt = 0;
  }

  async init() {
    const [osInfo, cpu] = await Promise.all([si.osInfo().catch(() => ({})), si.cpu().catch(() => ({}))]);
    this.info = {
      hostname: os.hostname(),
      os: [osInfo.distro, osInfo.release].filter(Boolean).join(" ") || `${os.type()} ${os.release()}`,
      kernel: osInfo.kernel || os.release(),
      arch: osInfo.arch || os.arch(),
      platform: os.platform(),
      cpu_model: [cpu.manufacturer, cpu.brand].filter(Boolean).join(" ") || os.cpus()[0]?.model,
    };
    // prime the delta-based counters so the first real sample is meaningful
    await si.currentLoad().catch(() => null);
    await si.processes().catch(() => null);
    this.last = await this.counters();
  }

  async counters() {
    let rx = 0, tx = 0, rd = 0, wr = 0;
    try {
      for (const n of await si.networkStats("*")) {
        if (SKIP_NIC.test(n.iface)) continue;
        rx += n.rx_bytes || 0;
        tx += n.tx_bytes || 0;
      }
    } catch { /* not available */ }
    try {
      const f = await si.fsStats();
      if (f) { rd = f.rx || 0; wr = f.wx || 0; }
    } catch { /* not available */ }
    return { t: Date.now() / 1000, rx, tx, rd, wr };
  }

  async disks() {
    const now = Date.now();
    if (this.diskCache && now - this.diskAt < DISKS_EVERY_MS) return this.diskCache;
    const out = [];
    const seen = new Set();
    for (const d of await si.fsSize().catch(() => [])) {
      if (SKIP_FS.has(String(d.type).toLowerCase()) || SKIP_MOUNT.test(d.mount || "")) continue;
      if (!d.size || d.size < 512 * 1024 * 1024 || seen.has(d.fs)) continue;
      seen.add(d.fs);
      out.push({ mount: d.mount, device: d.fs, fstype: d.type, total: d.size, used: d.used, percent: round1(d.use) });
    }
    this.diskCache = out;
    this.diskAt = now;
    return out;
  }

  async temperatures() {
    let t;
    try {
      t = await si.cpuTemperature();
    } catch {
      return null;
    }
    const sensors = [];
    if (valid(t.main)) sensors.push({ chip: "cpu", label: "Package", current: round1(t.main) });
    (t.cores || []).forEach((c, i) => valid(c) && sensors.push({ chip: "cpu", label: `Core ${i}`, current: round1(c) }));
    if (valid(t.chipset)) sensors.push({ chip: "chipset", label: "Chipset", current: round1(t.chipset) });
    (t.socket || []).forEach((c, i) => valid(c) && sensors.push({ chip: "socket", label: `Socket ${i}`, current: round1(c) }));
    if (!sensors.length && valid(t.max)) sensors.push({ chip: "cpu", label: "Max", current: round1(t.max) });
    if (!sensors.length) return null;
    sensors.sort((a, b) => b.current - a.current);
    const hottest = sensors[0];
    return { max: hottest.current, max_label: `${hottest.chip} ${hottest.label}`, sensors: sensors.slice(0, 12) };
  }

  async processes() {
    const now = Date.now();
    if (this.procs && now - this.procsAt < PROCESS_EVERY_MS) return this.procs;
    try {
      const p = await si.processes();
      const list = p.list.map((x) => ({ pid: x.pid, name: String(x.name || "?").slice(0, 40), cpu: round1(x.cpu) || 0, mem: round1(x.mem) || 0 }));
      this.procs = {
        count: p.all,
        top_cpu: [...list].sort((a, b) => b.cpu - a.cpu).slice(0, 5),
        top_mem: [...list].sort((a, b) => b.mem - a.mem).slice(0, 5),
      };
      this.procsAt = now;
    } catch {
      this.procs = this.procs || null;
    }
    return this.procs;
  }

  async collect() {
    const [load, mem, speed, disks, temp, procs, ctr] = await Promise.all([
      si.currentLoad(),
      si.mem(),
      si.cpuCurrentSpeed().catch(() => null),
      this.disks(),
      this.temperatures(),
      this.processes(),
      this.counters(),
    ]);
    const dt = Math.max(ctr.t - this.last.t, 0.001);
    const rate = (a, b) => Math.max(0, (a - b) / dt);
    const net = { rx_rate: rate(ctr.rx, this.last.rx), tx_rate: rate(ctr.tx, this.last.tx), rx_total: ctr.rx, tx_total: ctr.tx };
    const diskio = { read_rate: rate(ctr.rd, this.last.rd), write_rate: rate(ctr.wr, this.last.wr) };
    this.last = ctr;

    const uptime = os.uptime();
    const used = mem.total - mem.available;
    return {
      ...this.info,
      cpu: {
        percent: round1(load.currentLoad),
        per_core: (load.cpus || []).map((c) => round1(c.load)),
        count: os.cpus().length,
        load: os.platform() === "win32" ? null : os.loadavg().map((x) => Math.round(x * 100) / 100),
        freq_mhz: speed?.avg ? Math.round(speed.avg * 1000) : null,
      },
      mem: { total: mem.total, used, available: mem.available, percent: round1((used / mem.total) * 100) },
      swap: { total: mem.swaptotal, used: mem.swapused, percent: mem.swaptotal ? round1((mem.swapused / mem.swaptotal) * 100) : 0 },
      disks,
      net,
      diskio,
      temp,
      procs,
      boot_time: Math.round(Date.now() / 1000 - uptime),
      uptime,
    };
  }
}
