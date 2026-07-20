import { createBot } from "./channel/wechat.js";
import { hasSavedLogin } from "./channel/session.js";
import { initDatabase } from "./store/db.js";
import { callClaude } from "./engine/llm.js";
import { createConversationHandler } from "./engine/conversation.js";
import { startServer, state } from "./dashboard/server.js";

/**
 * Run one activity: database + dashboard + WeChat bot, until interrupted.
 *
 * One process serves one activity on one WeChat account. Running several
 * activities means several processes, each with its own `web_port`.
 */
export async function runActivity(activity) {
  console.log(`活动：${activity.name}（${activity.slug}）`);

  // Initialize database — scoped to this activity
  const db = initDatabase({
    eventId: activity.slug,
    eventName: activity.name,
  });
  console.log("✓ SQLite 数据库已就绪");

  // Start web dashboard — table columns follow the activity's field schema
  const server = startServer(db, {
    fields: activity.fields,
    eventName: activity.name,
    port: activity.webPort,
  });

  // QR login callbacks wired to the web dashboard.
  // NOTE: @wechatbot/wechatbot ignores `loginCallbacks` passed to the
  // constructor — callbacks are only honored when passed to run()/login().
  const loginCallbacks = {
    onQrUrl: (url) => {
      console.log("📱 请扫描二维码绑定微信账号：");
      console.log(url);
      state.botStatus = "waiting_qr";
      state.qrUrl = url;
    },
    onScanned: () => {
      console.log("✓ 已扫码，请在手机上确认登录...");
    },
  };

  // If a login is already saved, the SDK skips the QR flow and reuses it —
  // that's why no QR appears on the second run. Make that explicit so an empty
  // QR section doesn't look like a bug, and point at the reset path.
  if (hasSavedLogin()) {
    console.log(
      "检测到已保存的登录态，将跳过扫码直接复用。若需重新绑定（或登录已失效），",
    );
    console.log("请先运行 `zlink relogin` 清除登录态，再重新启动。");
  }

  // Create WeChat bot
  const bot = createBot();
  const handleMessage = createConversationHandler(db, callClaude);

  // Register message handler
  bot.onMessage(async (msg) => {
    console.log(
      `收到消息 [${msg.userId}]: ${msg.text.slice(0, 50)}${msg.text.length > 50 ? "..." : ""}`,
    );

    const replyFn = (text) => bot.reply(msg, text);
    await handleMessage(msg, replyFn);
  });

  // Lifecycle events -> update dashboard state
  // Session expiry: the SDK auto-retries login internally, but it re-logins
  // WITHOUT forwarding our callbacks, so the new QR only reaches the terminal
  // log — never state.qrUrl. Don't flip to "waiting_qr" (that would leave the
  // dashboard on a blank QR box forever); use a dedicated state that tells the
  // user where the QR actually is and how to force a clean rebind.
  bot.on("session:expired", () => {
    console.log("⚠ 会话已失效，SDK 正在尝试自动重新登录（二维码见上方终端日志）");
    state.botStatus = "session_expired";
    state.qrUrl = null;
  });

  bot.on("session:restored", () => {
    state.botStatus = "running";
    state.qrUrl = null;
  });

  bot.on("error", (err) => {
    console.error("Bot error:", err.message);
    state.botStatus = "error";
    state.errorMessage = err.message;
  });

  // Start (login + poll)
  try {
    console.log("正在登录 iLink...");
    await bot.run({ callbacks: loginCallbacks });
    state.botStatus = "running";
    state.qrUrl = null;
    console.log("✓ 已登录并开始接收消息");
  } catch (err) {
    console.error("启动失败:", err.message);
    state.botStatus = "error";
    state.errorMessage = err.message;
    // Keep server running so dashboard shows the error
  }

  // Graceful shutdown
  const shutdown = async () => {
    console.log("\n正在关闭...");
    await bot.stop();
    server.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
