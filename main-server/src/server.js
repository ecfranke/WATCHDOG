// HTTP API (sub servers + dashboard), WebSocket for live updates, static Mini App.
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { WebSocketServer } from "ws";
import { validateInitData } from "./telegramAuth.js";

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");

export function createServer(cfg, monitor, notifier) {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", true);
  app.use(express.json({ limit: "512kb" }));

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
  });

  // ---------------------------------------------------------------- sub server API
  app.post("/api/agent/report", agentAuth, (req, res) => {
    if (!req.body || typeof req.body !== "object") return res.status(422).json({ error: "JSON body required" });
    monitor.handleReport(req.server, req.body);
    res.json({ ok: true, id: req.server.id, name: req.server.name, interval_hint: 5 });
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
      res.json({ server: monitor.summary(server), token, env: monitor.envSnippet(token) });
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
    res.json({ token, env: monitor.envSnippet(token) });
  });

  app.delete("/api/servers/:id", userAuth, (req, res) => {
    if (!monitor.removeServer(req.params.id)) return res.status(404).json({ error: "unknown server" });
    res.json({ ok: true });
  });

  // ---------------------------------------------------------------- misc + static
  app.get("/healthz", (req, res) => res.json({ ok: true, servers: monitor.list().length }));
  app.get("/", (req, res) => res.redirect("/app/"));
  app.use("/app", express.static(PUBLIC_DIR, { index: "index.html", maxAge: 0 }));

  // ---------------------------------------------------------------- WebSocket
  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true });
  const clients = new Set();

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname !== "/ws") return socket.destroy();
    const user = checkUser(url.searchParams.get("initData"));
    if (user.error) {
      socket.write(`HTTP/1.1 ${user.error} Unauthorized\r\nConnection: close\r\n\r\n`);
      return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      clients.add(ws);
      ws.isAlive = true;
      ws.on("pong", () => (ws.isAlive = true));
      ws.on("message", (msg) => {
        if (String(msg) === "ping") ws.send(JSON.stringify({ type: "pong", now: Date.now() / 1000 }));
      });
      ws.on("close", () => clients.delete(ws));
      ws.on("error", () => clients.delete(ws));
      ws.send(JSON.stringify({ type: "snapshot", now: Date.now() / 1000, servers: monitor.snapshot(), config: dashboardConfig() }));
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
  server.on("close", () => clearInterval(heartbeat));

  const broadcast = (message) => {
    const data = JSON.stringify(message);
    for (const ws of clients) if (ws.readyState === 1) ws.send(data);
  };

  return { server, broadcast };
}
