#!/usr/bin/env node
// nginx config for running the main server behind aaPanel (or any nginx).
//
//   npm run nginx                      print + save nginx/watchdog.conf (from PORT / PUBLIC_URL in .env)
//   npm run nginx -- --apply           also put it into the aaPanel site config, test, reload nginx
//   npm run nginx -- --apply --vhost /etc/nginx/sites-enabled/watchdog.conf   (plain nginx)
//   npm run nginx -- --remove          take the Watchdog block out of the site config again
//   npm run nginx -- --port 9000       override the port
//
// --apply edits only the part between the "# ---- Watchdog main server" and "# ---- end Watchdog ----"
// markers, keeps a backup, runs `nginx -t`, and puts the backup back if the test fails.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const APP_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
export const AAPANEL_VHOST_DIR = process.env.AAPANEL_VHOST_DIR || "/www/server/panel/vhost/nginx";
const AAPANEL_NGINX = process.env.AAPANEL_NGINX_BIN || "/www/server/nginx/sbin/nginx";
const START = "# ---- Watchdog main server";
const END = "# ---- end Watchdog ----";

/** The location blocks that go inside the site's server { } block. */
export function buildNginx({ port, upstreamHost = "127.0.0.1", publicUrl = "" }) {
  const up = `http://${upstreamHost}:${port}`;
  const site = publicUrl ? ` for ${publicUrl}` : "";
  return `    ${START}${site} -> ${up} ----
    # Managed by "npm run nginx -- --apply" (Watchdog). Re-run it after changing PORT; edits here are replaced.

    # Live dashboard updates (WebSocket)
    location /ws {
        proxy_pass ${up};
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }

    # Everything else: dashboard, API, sub server reports
    location / {
        proxy_pass ${up};
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 60s;
        client_max_body_size 2m;
    }
    ${END}
`;
}

export function writeNginxFile(text) {
  const dir = path.join(APP_DIR, "nginx");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "watchdog.conf");
  fs.writeFileSync(file, text);
  return file;
}

// ------------------------------------------------------------------ applying to a site config

export function isAaPanel() {
  return fs.existsSync(AAPANEL_VHOST_DIR);
}

export function findVhost(domain) {
  const candidates = [
    path.join(AAPANEL_VHOST_DIR, `${domain}.conf`),
    `/etc/nginx/sites-available/${domain}`,
    `/etc/nginx/sites-available/${domain}.conf`,
    `/etc/nginx/conf.d/${domain}.conf`,
  ];
  const hit = candidates.find((f) => fs.existsSync(f));
  if (hit) return hit;
  // aaPanel names the file after the site's first domain; look for the domain in any server_name too
  if (isAaPanel()) {
    for (const f of fs.readdirSync(AAPANEL_VHOST_DIR)) {
      if (!f.endsWith(".conf")) continue;
      const p = path.join(AAPANEL_VHOST_DIR, f);
      const text = fs.readFileSync(p, "utf8");
      if (new RegExp(`server_name[^;]*\\s${domain.replace(/\./g, "\\.")}[\\s;]`).test(text)) return p;
    }
  }
  return null;
}

export function nginxBin() {
  if (fs.existsSync(AAPANEL_NGINX)) return AAPANEL_NGINX;
  for (const p of ["/usr/sbin/nginx", "/usr/local/sbin/nginx", "/usr/local/nginx/sbin/nginx"]) if (fs.existsSync(p)) return p;
  return "nginx";
}

// The block is always stored as "\n" + block, so removing exactly that gives back the original file.
const stripBlock = (text) => text.replace(new RegExp(`\\n?[ \\t]*${START}[\\s\\S]*?${END}[^\\n]*\\n`, "g"), "");

/** Insert (or replace) the Watchdog block: after "#SSL-END" in aaPanel configs, else before the server's closing brace. */
export function injectBlock(conf, block) {
  const text = stripBlock(conf);
  const ssl = /^[ \t]*#SSL-END.*$/m.exec(text);
  if (ssl) {
    const at = ssl.index + ssl[0].length;
    return `${text.slice(0, at)}\n${block}${text.slice(at)}`;
  }
  const close = text.lastIndexOf("}");
  if (close < 0) throw new Error("no server { } block found in the site config");
  return `${text.slice(0, close)}\n${block}${text.slice(close)}`;
}

/** Things in the site config that would clash with our `location /`. */
export function findConflicts(conf, domain) {
  const problems = [];
  const rest = stripBlock(conf);
  const hasRoot = (t) => /^\s*location\s+(\^~\s*)?\/\s*(\{|$)/m.test(t);
  if (hasRoot(rest)) problems.push('the site config already has a "location /" block (an earlier manual edit?)');
  // aaPanel puts URL-rewrite rules in an included file
  for (const m of rest.matchAll(/^\s*include\s+(\/[^;*]+);/gm)) {
    try {
      if (hasRoot(fs.readFileSync(m[1], "utf8"))) {
        problems.push(`the site's URL rewrite rules (${m[1]}) contain "location /"; set Rewrite to "0.default" (empty) in aaPanel → Website → ${domain} → URL rewrite`);
      }
    } catch {
      /* unreadable include: nginx -t will tell */
    }
  }
  const proxyDir = path.join(AAPANEL_VHOST_DIR, "proxy", domain);
  if (fs.existsSync(proxyDir) && fs.readdirSync(proxyDir).some((f) => f.endsWith(".conf"))) {
    problems.push(`aaPanel has a "Reverse proxy" for this site (${proxyDir}); delete it in aaPanel → Website → ${domain} → Reverse proxy`);
  }
  return problems;
}

function run(bin, args) {
  try {
    return { ok: true, out: execFileSync(bin, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
  } catch (e) {
    return { ok: false, out: `${e.stdout || ""}${e.stderr || ""}`.trim() || e.message };
  }
}

/**
 * Put the block into the site config, test, reload. Restores the backup if nginx rejects it.
 * @returns {{ vhost: string, backup: string, ssl: boolean }}
 */
export function applyToVhost({ vhost, domain, block, remove = false }) {
  const original = fs.readFileSync(vhost, "utf8");
  if (!remove) {
    const problems = findConflicts(original, domain);
    if (problems.length) throw new Error(`Can't add Watchdog to ${vhost}:\n  - ${problems.join("\n  - ")}`);
  }
  const updated = remove ? stripBlock(original) : injectBlock(original, block);
  if (updated === original) return { vhost, backup: null, ssl: /ssl_certificate\s/.test(original), unchanged: true };

  const backup = `${vhost}.watchdog-backup`;
  fs.writeFileSync(backup, original);
  fs.writeFileSync(vhost, updated);

  const bin = nginxBin();
  const test = run(bin, ["-t"]);
  if (!test.ok) {
    fs.writeFileSync(vhost, original);
    throw new Error(`nginx rejected the new config, so the old one was put back.\n${test.out}`);
  }
  const reload = run(bin, ["-s", "reload"]);
  if (!reload.ok) {
    // nginx may not be running yet; aaPanel's service script is the other usual way
    const alt = fs.existsSync("/etc/init.d/nginx") ? run("/etc/init.d/nginx", ["reload"]) : reload;
    if (!alt.ok) throw new Error(`Config saved and valid, but reloading nginx failed:\n${alt.out}\nRestart nginx in aaPanel → App Store → Nginx.`);
  }
  return { vhost, backup, ssl: /ssl_certificate\s/.test(updated) };
}

// ------------------------------------------------------------------ CLI

function arg(name) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  dotenv.config({ path: process.env.WATCHDOG_ENV_FILE || path.join(APP_DIR, ".env"), quiet: true });
  const port = Number(arg("--port") || process.env.PORT || 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`Invalid port: ${port}`);
    process.exit(1);
  }
  const publicUrl = (process.env.PUBLIC_URL || "").trim();
  const block = buildNginx({ port, publicUrl });
  const file = writeNginxFile(block);
  const apply = process.argv.includes("--apply");
  const remove = process.argv.includes("--remove");

  if (!apply && !remove) {
    console.log(block);
    console.log(`Saved to ${path.relative(process.cwd(), file) || file}`);
    console.log("Run with --apply to put it into the aaPanel site config automatically.");
    process.exit(0);
  }

  let domain = "";
  try {
    domain = new URL(publicUrl).hostname;
  } catch {
    /* handled below */
  }
  const vhost = arg("--vhost") || (domain && findVhost(domain));
  if (!vhost) {
    console.error(
      domain
        ? `No nginx site config found for ${domain}.\n` +
            (isAaPanel()
              ? `Create the site first: aaPanel → Website → Add site → ${domain}, then SSL → Let's Encrypt.`
              : "Pass the site's config file with --vhost /path/to/site.conf")
        : "PUBLIC_URL is not set in .env (run npm run setup first).",
    );
    process.exit(2);
  }
  try {
    const r = applyToVhost({ vhost, domain, block, remove });
    if (r.unchanged) console.log(`✔ ${vhost} already up to date (port ${port}).`);
    else if (remove) console.log(`✔ Removed the Watchdog block from ${vhost} and reloaded nginx (backup: ${r.backup}).`);
    else console.log(`✔ ${vhost}: Watchdog → 127.0.0.1:${port}, nginx tested and reloaded (backup: ${r.backup}).`);
    if (!remove && !r.ssl) {
      console.log(`⚠ No SSL certificate on this site yet. aaPanel → Website → ${domain} → SSL → Let's Encrypt, then Force HTTPS.\n  The Telegram dashboard only opens over HTTPS.`);
    }
  } catch (e) {
    console.error(`✖ ${e.message}`);
    process.exit(3);
  }
}
