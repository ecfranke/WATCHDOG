// Watchdog main server — entry point.
import { loadConfig } from "./config.js";
import { Store } from "./store.js";
import { Monitor } from "./monitor.js";
import { Notifier } from "./notifier.js";
import { createBot, runBot } from "./bot.js";
import { createServer } from "./server.js";

const cfg = loadConfig();
const store = new Store(cfg.dataFile);

// The monitor pushes to the dashboard through `broadcast`, which exists once the HTTP server does.
let broadcast = () => {};
const notifier = new Notifier(null, cfg, store);
const monitor = new Monitor(cfg, store, (text, important) => notifier.send(text, important), (msg) => broadcast(msg));
const realBot = createBot(cfg, monitor, notifier);
notifier.api = realBot.api;

const http = createServer(cfg, monitor, notifier);
broadcast = http.broadcast;

http.server.listen(cfg.port, cfg.host, () => {
  console.log(`Watchdog main server listening on http://${cfg.host}:${cfg.port}`);
  console.log(`Sub servers connect to: ${cfg.publicUrl || "(set PUBLIC_URL)"}`);
});

monitor.start();
let announced = false;
runBot(realBot, cfg, () => {
  if (announced) return;
  announced = true;
  notifier.send(`🐕 Watchdog main server started — ${monitor.list().length} server(s) registered.`);
});

function shutdown(signal) {
  console.log(`${signal} received, shutting down`);
  monitor.stop();
  store.flush();
  realBot.stop().catch(() => {});
  http.server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
