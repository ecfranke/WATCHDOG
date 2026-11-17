// Telegram bot: status, alerts, token management for sub servers, dashboard launcher.
import { Bot, InlineKeyboard } from "grammy";
import { esc, fmtClock, fmtDuration } from "./format.js";

const HTML = { parse_mode: "HTML", link_preview_options: { is_disabled: true } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const COMMANDS = [
  { command: "status", description: "Status of all servers" },
  { command: "alerts", description: "Servers down + active alerts" },
  { command: "servers", description: "List servers and their tokens" },
  { command: "add", description: "Add a sub server: /add web-1" },
  { command: "token", description: "New token for a server: /token web-1" },
  { command: "remove", description: "Remove a server: /remove web-1" },
  { command: "version", description: "Versions of main + sub servers" },
  { command: "update", description: "Update from GitHub: /update all | main | <name>" },
  { command: "dashboard", description: "Open the live dashboard" },
  { command: "mute", description: "Mute notifications: /mute 60" },
  { command: "unmute", description: "Turn notifications back on" },
  { command: "help", description: "Help" },
];

const HELP =
  "🐕 <b>Watchdog</b> — main server\n\n" +
  "<b>Servers</b>\n" +
  "/add &lt;name&gt; — create a sub server and get its token\n" +
  "/token &lt;name&gt; — replace a server's token (the old one stops working)\n" +
  "/remove &lt;name&gt; — remove a server and revoke its token\n" +
  "/servers — list servers\n\n" +
  "<b>Monitoring</b>\n" +
  "/status — CPU, RAM, disk, temperature of every server\n" +
  "/alerts — servers down + active alerts\n" +
  "/dashboard — live charts\n" +
  "/mute 60 · /unmute — silence notifications\n\n" +
  "<b>Updates</b> (from your GitHub repo)\n" +
  "/version — which version each server runs\n" +
  "/update all · /update main · /update &lt;name&gt; — update now\n\n" +
  "To connect a server: /add it here, then put the two lines you get into the <code>.env</code> " +
  "of the sub-server project on that machine and start it.";

export function createBot(cfg, monitor, notifier, botOptions = {}, updateMain = null) {
  const bot = new Bot(cfg.botToken, botOptions);
  const isPrivate = (ctx) => ctx.chat?.type === "private";

  const statusKeyboard = (ctx) => {
    const kb = new InlineKeyboard().text("🔄 Refresh", "refresh");
    if (cfg.webappUrl && isPrivate(ctx)) kb.webApp("📈 Dashboard", cfg.webappUrl);
    return kb;
  };

  const tokenMessage = (s, token, headline) => {
    const install = monitor.installCommand(token);
    return (
      `${headline}\n\nPut this in the <code>.env</code> of the sub server:\n` +
      `<pre>${esc(monitor.envSnippet(token))}</pre>\n` +
      (install
        ? `Or install it in one go on the sub server (Linux + systemd, auto-updates from GitHub):\n<pre>${esc(install)}</pre>\n`
        : `Then start it (<code>sudo bash install.sh</code> or <code>npm start</code>).\n\n`) +
      `🔐 The token is shown only this once. Lost it? /token ${esc(s.id)}`
    );
  };

  const unknown = (ctx, q) => {
    const names = monitor.list().map((s) => esc(s.name)).join(", ") || "none yet";
    return ctx.reply(`No server called <b>${esc(q)}</b>.\nServers: ${names}`, HTML);
  };

  // ---- access control: only ADMIN_IDS may use the bot
  bot.use(async (ctx, next) => {
    const uid = ctx.from?.id;
    if (uid && cfg.adminIds.includes(uid)) return next();
    if (ctx.callbackQuery) return ctx.answerCallbackQuery({ text: "Not allowed" });
    if (isPrivate(ctx) && ctx.message?.text?.startsWith("/start")) {
      return ctx.reply(
        `⛔ You are not allowed to use this bot.\nYour Telegram ID is <code>${uid}</code> — ` +
          "add it to <code>ADMIN_IDS</code> on the main server if this is your bot.",
        HTML,
      );
    }
  });

  bot.command(["start", "help"], (ctx) => ctx.reply(HELP, { ...HTML, reply_markup: statusKeyboard(ctx) }));

  bot.command("status", (ctx) => ctx.reply(monitor.statusText(), { ...HTML, reply_markup: statusKeyboard(ctx) }));

  bot.callbackQuery("refresh", async (ctx) => {
    try {
      await ctx.editMessageText(monitor.statusText(), { ...HTML, reply_markup: statusKeyboard(ctx) });
    } catch {
      /* message is not modified */
    }
    await ctx.answerCallbackQuery({ text: "Updated" });
  });

  bot.command("alerts", (ctx) => {
    const offline = monitor.list().filter((s) => s.status === "offline");
    const alerts = monitor.activeAlerts();
    if (!offline.length && !alerts.length) return ctx.reply("✅ All clear — no servers down, no active alerts.");
    const now = Date.now() / 1000;
    const lines = ["⚠️ <b>Active problems</b>", ""];
    for (const s of offline) lines.push(`🔴 <b>${esc(s.name)}</b> offline since ${fmtClock(s.statusSince)}`);
    for (const [s, a] of alerts) {
      const where = a.detail ? ` on ${esc(a.detail)}` : "";
      lines.push(`⚠️ <b>${esc(s.name)}</b>: ${a.label}${where} — ${Math.round(a.value)}${a.unit} (for ${fmtDuration(now - a.since)})`);
    }
    return ctx.reply(lines.join("\n"), HTML);
  });

  bot.command("servers", (ctx) => {
    const list = monitor.list();
    if (!list.length) return ctx.reply("No servers yet. Add one with /add &lt;name&gt;", HTML);
    const icon = { online: "🟢", offline: "🔴", pending: "⚪" };
    const lines = ["🖥 <b>Servers</b>", ""];
    for (const s of list) {
      const state = s.status === "pending" ? "never connected" : s.status === "online" ? "online" : `offline since ${fmtClock(s.statusSince)}`;
      lines.push(`${icon[s.status]} <b>${esc(s.name)}</b> <code>${esc(s.id)}</code> — ${state}`);
      lines.push(`    token created ${new Date(s.tokenCreatedAt * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`);
    }
    return ctx.reply(lines.join("\n"), HTML);
  });

  bot.command("add", async (ctx) => {
    if (!isPrivate(ctx)) return ctx.reply("For safety, tokens are only sent in a private chat with the bot.");
    const name = ctx.match?.trim();
    if (!name) return ctx.reply("Usage: /add &lt;name&gt;\nExample: /add web-1", HTML);
    try {
      const { server, token } = monitor.addServer(name);
      return ctx.reply(tokenMessage(server, token, `✅ Server <b>${esc(server.name)}</b> added.`), HTML);
    } catch (e) {
      return ctx.reply(`❌ ${esc(e.message)}`, HTML);
    }
  });

  bot.command("token", (ctx) => {
    if (!isPrivate(ctx)) return ctx.reply("For safety, tokens are only sent in a private chat with the bot.");
    const q = ctx.match?.trim();
    if (!q) return ctx.reply("Usage: /token &lt;name&gt;", HTML);
    const s = monitor.find(q);
    if (!s) return unknown(ctx, q);
    return ctx.reply(
      `Make a new token for <b>${esc(s.name)}</b>?\nThe current token stops working immediately, so update the sub server's .env right after.`,
      { ...HTML, reply_markup: new InlineKeyboard().text("🔑 New token", `tok:${s.id}`).text("Cancel", "cancel") },
    );
  });

  bot.callbackQuery(/^tok:(.+)$/, async (ctx) => {
    const s = monitor.get(ctx.match[1]);
    if (!s) return ctx.answerCallbackQuery({ text: "Server no longer exists" });
    const token = monitor.rotateToken(s.id);
    await ctx.editMessageText(tokenMessage(s, token, `🔑 New token for <b>${esc(s.name)}</b>. The old one is revoked.`), HTML);
    return ctx.answerCallbackQuery();
  });

  bot.command("remove", (ctx) => {
    const q = ctx.match?.trim();
    if (!q) return ctx.reply("Usage: /remove &lt;name&gt;", HTML);
    const s = monitor.find(q);
    if (!s) return unknown(ctx, q);
    return ctx.reply(`Remove <b>${esc(s.name)}</b>? Its token is revoked and it stops being monitored.`, {
      ...HTML,
      reply_markup: new InlineKeyboard().text("🗑 Remove", `rm:${s.id}`).text("Cancel", "cancel"),
    });
  });

  bot.callbackQuery(/^rm:(.+)$/, async (ctx) => {
    const s = monitor.get(ctx.match[1]);
    if (!s || !monitor.removeServer(s.id)) return ctx.answerCallbackQuery({ text: "Already removed" });
    await ctx.editMessageText(`🗑 Removed <b>${esc(s.name)}</b>. Its token no longer works.`, HTML);
    return ctx.answerCallbackQuery();
  });

  bot.callbackQuery("cancel", async (ctx) => {
    await ctx.editMessageText("Cancelled.");
    return ctx.answerCallbackQuery();
  });

  // ---- versions & updates
  bot.command("version", (ctx) => {
    const latest = monitor.latestCommit();
    const mv = monitor.updater?.info();
    const lines = ["🏷 <b>Versions</b>", ""];
    if (mv?.enabled) {
      const state = !latest ? "" : mv.commit === latest ? " ✅" : mv.pending_restart ? " ⏳ restart pending" : ` ⬆️ behind (latest <code>${latest}</code>)`;
      lines.push(`<b>Main server</b>: <code>${mv.commit}</code> on ${esc(mv.branch)}${state}`);
      lines.push(`    ${esc(mv.remote)} · auto-update ${mv.auto ? "on" : "off"}`);
      if (mv.error) lines.push(`    ❗ ${esc(mv.error)}`);
    } else {
      lines.push(`<b>Main server</b>: auto-update off (${esc(mv?.reason || "not a git install")})`);
    }
    lines.push("");
    for (const s of monitor.list()) {
      const v = s.version;
      let state;
      if (s.status === "pending") state = "never connected";
      else if (!v?.commit) state = `no version info${v?.reason ? ` (${esc(v.reason)})` : ""}`;
      else {
        const mark = !latest ? "" : v.commit === latest ? " ✅" : v.pending_restart ? " ⏳ restart pending" : " ⬆️ behind";
        state = `<code>${esc(v.commit)}</code>${mark}${v.auto === false ? " · manual updates" : ""}`;
      }
      lines.push(`${s.status === "online" ? "🟢" : s.status === "pending" ? "⚪" : "🔴"} <b>${esc(s.name)}</b>: ${state}${s.pendingUpdate ? " · update requested" : ""}`);
      if (v?.error) lines.push(`    ❗ ${esc(v.error)}`);
    }
    if (latest) lines.push("", `Latest on GitHub: <code>${latest}</code>`);
    return ctx.reply(lines.join("\n"), HTML);
  });

  bot.command("update", async (ctx) => {
    const arg = (ctx.match || "").trim();
    if (!arg) {
      return ctx.reply(
        "Usage:\n/update all — every sub server, then the main server\n/update main — only the main server\n/update &lt;name&gt; — one sub server",
        HTML,
      );
    }
    const doMain = async () => {
      if (!updateMain) return "Main server: updates not available";
      try {
        const r = await updateMain("telegram");
        if (r.status === "up-to-date") return `Main server: already up to date (<code>${r.version.commit}</code>)`;
        if (r.status === "busy") return "Main server: an update is already running";
        if (r.status === "updated") return `Main server: pulled <code>${r.from}</code> → <code>${r.to}</code> (no main-server changes, no restart)`;
        return r.restarting ? `Main server: updating <code>${r.from}</code> → <code>${r.to}</code>, restarting…` : `Main server: updated to <code>${r.to}</code>, restart it to apply`;
      } catch (e) {
        return `Main server: ❗ ${esc(e.message)}`;
      }
    };
    if (arg.toLowerCase() === "main") return ctx.reply(await doMain(), HTML);

    const targets = arg.toLowerCase() === "all" ? monitor.list().filter((s) => s.status !== "pending") : [monitor.find(arg)].filter(Boolean);
    if (!targets.length) return arg.toLowerCase() === "all" ? ctx.reply("No connected sub servers.") : unknown(ctx, arg);
    for (const s of targets) monitor.requestUpdate(s.id);
    const names = targets.map((s) => `<b>${esc(s.name)}</b>`).join(", ");
    let text = `⬆️ Update requested for ${names}.\nOnline servers pull it on their next report (a few seconds); offline ones when they come back. You'll get a message for each one that updates.`;
    if (arg.toLowerCase() === "all") text += `\n\n${await doMain()}`;
    return ctx.reply(text, HTML);
  });

  bot.command("dashboard", (ctx) => {
    if (!cfg.webappUrl) return ctx.reply("The dashboard is not configured. Set <code>WEBAPP_URL</code>.", HTML);
    if (!isPrivate(ctx)) return ctx.reply("Open the dashboard from a private chat with the bot.");
    return ctx.reply("📈 Live dashboard:", { reply_markup: new InlineKeyboard().webApp("Open dashboard", cfg.webappUrl) });
  });

  bot.command("mute", (ctx) => {
    const minutes = ctx.match ? parseInt(ctx.match, 10) : 60;
    if (!Number.isFinite(minutes) || minutes <= 0) return ctx.reply("Usage: /mute 60  (minutes)");
    const until = notifier.mute(Math.min(minutes, 60 * 24 * 7));
    return ctx.reply(`🔕 Notifications muted for ${fmtDuration(minutes * 60)} (until ${fmtClock(until)}).`);
  });

  bot.command("unmute", (ctx) => {
    notifier.unmute();
    return ctx.reply("🔔 Notifications are on.");
  });

  bot.catch((err) => console.error("bot handler error:", err.error?.message || err.message));
  return bot;
}

/** Configure the bot and long-poll forever, retrying while Telegram is unreachable. */
export async function runBot(bot, cfg, onReady) {
  for (;;) {
    try {
      await bot.init();
      await bot.api.setMyCommands(COMMANDS);
      if (cfg.webappUrl) {
        await bot.api.setChatMenuButton({
          menu_button: { type: "web_app", text: "Dashboard", web_app: { url: cfg.webappUrl } },
        });
      }
      console.log(`Bot @${bot.botInfo.username} is running`);
      onReady?.();
      await bot.start({ allowed_updates: ["message", "callback_query"] });
      return; // bot.stop() was called
    } catch (e) {
      console.error(`Telegram bot error: ${e.description || e.message} — retrying in 30s`);
      await sleep(30_000);
    }
  }
}
