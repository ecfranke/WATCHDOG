// Auto-update from GitHub, shared by main-server and sub-server.
//
// Works when the app runs from a git clone of your repo (that's what install.sh sets up):
//   1. git fetch origin <branch>
//   2. if behind: git reset --hard origin/<branch>
//   3. npm ci if package.json / package-lock.json changed
//   4. node --check every source file
//   5. any failure → reset back to the previous commit (rollback)
//   6. the caller restarts the process (systemd / pm2 brings it back on the new code)
//
// Only Node built-ins + the git and npm CLIs are used.
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const short = (sha) => (sha ? String(sha).slice(0, 7) : null);

function run(cmd, args, { cwd, timeout = 120_000, label } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { cwd, timeout, maxBuffer: 20 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
      (err, stdout, stderr) => {
        if (err) {
          const lines = String(stderr || err.message).split("\n").map((l) => l.trim()).filter(Boolean);
          const detail = lines.find((l) => /^(\w*Error|error|fatal|npm ERR!)\b/i.test(l)) || lines.slice(-2).join(" ");
          return reject(new Error(`${label || cmd} failed: ${detail}`)); // never echo args: they may hold a token
        }
        resolve(String(stdout).trim());
      },
    );
  });
}

/** Remove credentials from a remote URL before showing or reporting it. */
export function cleanRemote(url) {
  return String(url || "").replace(/\/\/[^@/]+@/, "//");
}

/** https://github.com/owner/repo(.git) or git@github.com:owner/repo.git → { owner, repo } */
export function parseGithub(url) {
  const m = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(cleanRemote(url));
  return m ? { owner: m[1], repo: m[2] } : null;
}

/** True when a process manager will restart us after we exit (systemd, pm2, or told so). */
export function isSupervised() {
  return Boolean(process.env.INVOCATION_ID || process.env.pm_id !== undefined || process.env.WATCHDOG_SUPERVISED === "1");
}

export class Updater {
  /**
   * @param {object} o
   * @param {"main-server"|"sub-server"} o.component  folder of this app inside the repo
   * @param {string}  o.appDir           absolute path of that folder
   * @param {string}  [o.branch]         branch to follow (default: the checked-out branch)
   * @param {boolean} [o.auto]           install updates automatically
   * @param {number}  [o.intervalMinutes]
   * @param {string}  [o.githubToken]    for private repositories
   * @param {(msg:string)=>void} [o.log]
   */
  constructor(o) {
    this.component = o.component;
    this.appDir = o.appDir;
    this.branch = o.branch || null;
    this.auto = o.auto !== false;
    this.intervalMinutes = Math.max(1, Number(o.intervalMinutes) || 30);
    this.githubToken = o.githubToken || "";
    this.log = o.log || console.log;
    this.enabled = false;
    this.reason = null;
    this.commit = null; // commit of the code that is running
    this.latest = null; // newest commit on origin/<branch> at the last check
    this.lastCheck = null;
    this.lastError = null;
    this.pendingRestart = false;
    this.busy = false;
  }

  authArgs() {
    if (!this.githubToken) return [];
    const basic = Buffer.from(`x-access-token:${this.githubToken}`).toString("base64");
    return ["-c", `http.https://github.com/.extraheader=AUTHORIZATION: basic ${basic}`];
  }

  git(args, timeout) {
    return run("git", [...this.authArgs(), ...args], { cwd: this.appDir, timeout, label: `git ${args[0]}` });
  }

  async init() {
    try {
      await run("git", ["--version"], { label: "git" });
    } catch {
      return this.disable("git is not installed");
    }
    if (fs.existsSync("/.dockerenv")) return this.disable("running in Docker (rebuild the image to update)");
    try {
      this.root = await this.git(["rev-parse", "--show-toplevel"]);
    } catch {
      return this.disable("not installed from a git clone");
    }
    this.commit = await this.git(["rev-parse", "HEAD"]);
    const current = await this.git(["rev-parse", "--abbrev-ref", "HEAD"]);
    this.branch ||= current;
    if (this.branch === "HEAD") return this.disable("detached HEAD; check out a branch");
    if (current !== this.branch) return this.disable(`checked out "${current}" but UPDATE_BRANCH is "${this.branch}"`);
    this.remote = cleanRemote(await this.git(["remote", "get-url", "origin"]).catch(() => ""));
    if (!this.remote) return this.disable('no "origin" remote');
    this.enabled = true;
    return this.info();
  }

  disable(reason) {
    this.enabled = false;
    this.reason = reason;
    return this.info();
  }

  info() {
    return {
      commit: short(this.commit),
      branch: this.branch,
      remote: this.remote || null,
      enabled: this.enabled,
      auto: this.auto,
      reason: this.reason,
      latest: short(this.latest),
      last_check: this.lastCheck,
      error: this.lastError,
      pending_restart: this.pendingRestart,
    };
  }

  /** Fetch and compare. Does not change any files. */
  async check() {
    await this.git(["fetch", "--quiet", "origin", this.branch], 90_000);
    this.latest = await this.git(["rev-parse", `origin/${this.branch}`]);
    this.lastCheck = Date.now() / 1000;
    const head = await this.git(["rev-parse", "HEAD"]);
    if (head === this.latest) return { behind: false, from: head, to: head, files: [] };
    const files = (await this.git(["diff", "--name-only", head, this.latest])).split("\n").filter(Boolean);
    const mine = (f) => f.startsWith(`${this.component}/`) || f.startsWith("shared/");
    return { behind: true, from: head, to: this.latest, files, relevant: files.some(mine) };
  }

  npmCommand() {
    const besideNode = path.join(path.dirname(process.execPath), process.platform === "win32" ? "npm.cmd" : "npm");
    return fs.existsSync(besideNode) ? besideNode : "npm";
  }

  async installDeps() {
    const hasLock = fs.existsSync(path.join(this.appDir, "package-lock.json"));
    const args = hasLock ? ["ci", "--omit=dev", "--no-audit", "--no-fund"] : ["install", "--omit=dev", "--no-audit", "--no-fund"];
    await run(this.npmCommand(), args, { cwd: this.appDir, timeout: 600_000, label: "npm install" });
  }

  async verify() {
    const files = [];
    const walk = (dir) => {
      if (!fs.existsSync(dir)) return;
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(m?js)$/.test(e.name)) files.push(p);
      }
    };
    walk(path.join(this.appDir, "src"));
    walk(path.join(this.root, "shared"));
    for (const f of files) await run(process.execPath, ["--check", f], { label: `syntax check of ${path.relative(this.root, f)}` });
  }

  /**
   * Check and, if behind, install the update.
   * @returns {Promise<{status:"up-to-date"|"restart"|"updated", from?:string, to?:string}>}
   *   "restart": this app's code changed → the caller should restart
   *   "updated": only other parts of the repo changed → nothing to restart
   */
  async update() {
    if (!this.enabled) throw new Error(`auto-update unavailable: ${this.reason}`);
    if (this.busy) return { status: "busy" };
    this.busy = true;
    try {
      const c = await this.check();
      if (!c.behind) {
        this.lastError = null;
        return { status: "up-to-date" };
      }
      const dirty = await this.git(["status", "--porcelain", "--untracked-files=no"]);
      if (dirty) throw new Error("local changes in the checkout; commit or discard them to resume auto-update");

      const depsChanged = c.files.some((f) => f === `${this.component}/package.json` || f === `${this.component}/package-lock.json`);
      this.log(`Updating ${short(c.from)} → ${short(c.to)} (${c.files.length} file(s) changed)`);
      await this.git(["reset", "--hard", "--quiet", c.to]);
      try {
        if (depsChanged) await this.installDeps();
        await this.verify();
      } catch (e) {
        this.log(`Update failed, rolling back to ${short(c.from)}: ${e.message}`);
        await this.git(["reset", "--hard", "--quiet", c.from]);
        if (depsChanged) await this.installDeps().catch((e2) => this.log(`rollback npm install failed: ${e2.message}`));
        throw new Error(`update to ${short(c.to)} failed and was rolled back: ${e.message}`);
      }
      this.lastError = null;
      if (c.relevant) {
        this.pendingRestart = true;
        return { status: "restart", from: short(c.from), to: short(c.to) };
      }
      this.commit = c.to; // nothing of ours changed: the running code already equals the new commit
      return { status: "updated", from: short(c.from), to: short(c.to) };
    } catch (e) {
      this.lastError = e.message;
      throw e;
    } finally {
      this.busy = false;
    }
  }

  /**
   * Periodically check (and, with auto on, install) updates.
   * onResult(result) is called after an update was installed; onError(err) on failures.
   */
  start(onResult, onError) {
    if (!this.enabled) return;
    const tick = async () => {
      try {
        if (this.auto) {
          const r = await this.update();
          if (r.status === "restart" || r.status === "updated") await onResult?.(r);
        } else {
          await this.check(); // just keep `latest` fresh for /version
        }
      } catch (e) {
        onError?.(e);
      }
    };
    this.firstTimer = setTimeout(tick, 60_000);
    this.timer = setInterval(tick, this.intervalMinutes * 60_000);
    this.firstTimer.unref?.();
    this.timer.unref?.();
  }

  stop() {
    clearTimeout(this.firstTimer);
    clearInterval(this.timer);
  }
}

/** Load the updater if the shared folder is present (it is in a git clone of the repo). */
export async function createUpdater(opts) {
  const u = new Updater(opts);
  try {
    await u.init();
  } catch (e) {
    u.disable(e.message);
  }
  return u;
}
