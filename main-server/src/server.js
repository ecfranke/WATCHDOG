// HTTP API (sub servers + dashboard), WebSocket for live updates, static Mini App.
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { WebSocketServer } from "ws";
import { validateInitData } from "./telegramAuth.js";

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");

export function createServer(cfg, monitor, notifier, updateMain) {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", "loopback"); // aaPanel/nginx on the same machine
  app.use(express.json({ limit: "256kb" }));

  // ---------------------------------------------------------------- auth helpers
  const agentAuth = (req, res, next) => {
    const m = /^Bearer\s+(.+)$/i.exec(req.get("authorization") || "");
    const server = m && monitor.authenticate(m[1].trim());
    if (!server) return res.status(401).json({ error: "invalid or revoked token" });
    req.server = server;
    next();
  };

  const checkUser = (initData) => {
    if (cfg.devNoAuth) return { id: 0, first_name: "dev" };
    const user = validateInitData(initData, cfg.botToken);
    if (!user) return { error: 401 };
    if (!cfg.adminIds.includes(user.id)) return { error: 403 };
    return user;
  };

  const userAuth = (req, res, next) => {
    const user = checkUser(req.get("x-telegram-init-data"));
    if (user.error) return res.status(user.error).json({ error: user.error === 403 ? "not an admin" : "invalid Telegram login" });
    req.user = user;
    next();
  };

  const dashboardConfig = () => ({
    thresholds: Object.fromEntries(monitor.rules.map((r) => [r.key, r.threshold])),
    history_minutes: cfg.historyMinutes,
    offline_after: cfg.offlineAfter,
    muted_until: notifier.isMuted() ? notifier.mutedUntil() : null,
    main_version: monitor.updater ? monitor.updater.info() : null,
    latest_commit: monitor.latestCommit(),
  });

  // ---------------------------------------------------------------- sub server API
  app.post("/api/agent/report", agentAuth, (req, res) => {
    if (!req.body || typeof req.body !== "object") return res.status(422).json({ error: "JSON body required" });
    const { update } = monitor.handleReport(req.server, req.body);
    res.json({ ok: true, id: req.server.id, name: req.server.name, update });
  });

  app.post("/api/agent/goodbye", agentAuth, (req, res) => {
    monitor.handleGoodbye(req.server, String(req.body?.reason || ""));
    res.json({ ok: true });
  });

  // ---------------------------------------------------------------- dashboard API
  app.get("/api/me", userAuth, (req, res) => res.json({ user: req.user }));

  app.get("/api/servers", userAuth, (req, res) =>
    res.json({ now: Date.now() / 1000, servers: monitor.snapshot(), config: dashboardConfig() }),
  );

  app.post("/api/servers", userAuth, (req, res) => {
    try {
      const { server, token } = monitor.addServer(req.body?.name);
      res.json({ server: monitor.summary(server), token, env: monitor.envSnippet(token), install: monitor.installCommand(token) });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  app.get("/api/servers/:id/history", userAuth, (req, res) => {
    if (!monitor.get(req.params.id)) return res.status(404).json({ error: "unknown server" });
    res.json({ now: Date.now() / 1000, history: monitor.history(req.params.id) });
  });

  app.post("/api/servers/:id/token", userAuth, (req, res) => {
    if (!monitor.get(req.params.id)) return res.status(404).json({ error: "unknown server" });
    const token = monitor.rotateToken(req.params.id);
    res.json({ token, env: monitor.envSnippet(token), install: monitor.installCommand(token) });
  });

  app.post("/api/servers/:id/update", userAuth, (req, res) => {
    if (!monitor.requestUpdate(req.params.id)) return res.status(404).json({ error: "unknown server" });
    res.json({ ok: true });
  });

  app.post("/api/main/update", userAuth, async (req, res) => {
    // npm ci can outlast nginx's 60 s proxy timeout: answer after 45 s at most, the update keeps going
    const running = updateMain("dashboard");
    const slow = new Promise((r) => setTimeout(() => r({ status: "running" }), 45_000).unref());
    try {
      res.json(await Promise.race([running, slow]));
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
    running.catch(() => {}); // already reported, or reported via Telegram later
  });

  app.delete("/api/servers/:id", userAuth, (req, res) => {
    if (!monitor.removeServer(req.params.id)) return res.status(404).json({ error: "unknown server" });
    res.json({ ok: true });
  });

  // ---------------------------------------------------------------- misc + static
  app.get("/healthz", (req, res) => res.json({ ok: true, servers: monitor.list().length }));
  app.get("/", (req, res) => res.redirect("/app/"));
  app.use("/app", express.static(PUBLIC_DIR, { index: "index.html", maxAge: 0 }));

  // malformed JSON or other request errors: a short JSON answer instead of an HTML error page
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    const status = err.status || err.statusCode || 500;
    if (status >= 500) console.error(`${req.method} ${req.path}:`, err);
    res.status(status).json({ error: status >= 500 ? "internal error" : err.type || err.message });
  });

  // ---------------------------------------------------------------- WebSocket
  const server = http.createServer(app);
  // Dashboard clients only ever send tiny messages.
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
  const clients = new Set();

  // Auth: the dashboard sends {"type":"auth","initData":…} as its first message, so the Telegram
  // login never appears in URLs (and nginx access logs). ?initData= in the URL still works.
  const AUTH_TIMEOUT_MS = 10_000;
  const admit = (ws) => {
    ws.authed = true;
    clients.add(ws);
    ws.send(JSON.stringify({ type: "snapshot", now: Date.now() / 1000, servers: monitor.snapshot(), config: dashboardConfig() }));
  };

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname !== "/ws") return socket.destroy();
    const fromUrl = url.searchParams.get("initData");
    if (fromUrl) {
      const user = checkUser(fromUrl);
      if (user.error) {
        socket.write(`HTTP/1.1 ${user.error} Unauthorized\r\nConnection: close\r\n\r\n`);
        return socket.destroy();
      }
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.isAlive = true;
      ws.on("pong", () => (ws.isAlive = true));
      ws.on("close", () => {
        clients.delete(ws);
        clearTimeout(ws.authTimer);
      });
      ws.on("error", () => clients.delete(ws));
      ws.on("message", (msg) => {
        const text = String(msg);
        if (text === "ping") {
          if (ws.authed) ws.send(JSON.stringify({ type: "pong", now: Date.now() / 1000 }));
          return;
        }
        if (ws.authed) return;
        let m;
        try {
          m = JSON.parse(text);
        } catch {
          return ws.close(4400, "bad message");
        }
        if (m?.type !== "auth") return ws.close(4401, "auth first");
        const user = checkUser(String(m.initData || ""));
        if (user.error) return ws.close(user.error === 403 ? 4403 : 4401, user.error === 403 ? "not an admin" : "invalid login");
        clearTimeout(ws.authTimer);
        admit(ws);
      });
      if (fromUrl) admit(ws);
      else ws.authTimer = setTimeout(() => ws.authed || ws.close(4401, "auth timeout"), AUTH_TIMEOUT_MS);
    });
  });

  // drop dead dashboard connections
  const heartbeat = setInterval(() => {
    for (const ws of clients) {
      if (!ws.isAlive) {
        ws.terminate();
        clients.delete(ws);
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, 30_000);
  heartbeat.unref();

  const broadcast = (message) => {
    const data = JSON.stringify(message);
    for (const ws of clients) if (ws.readyState === 1 && ws.bufferedAmount < 1 << 20) ws.send(data); // skip stalled clients
  };

  /** Stop accepting connections and close every open one (dashboard sockets included). */
  const close = () =>
    new Promise((resolve) => {
      clearInterval(heartbeat);
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      server.close(() => resolve());
      server.closeAllConnections?.();
    });

  return { server, broadcast, close };
}
