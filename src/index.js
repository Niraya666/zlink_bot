import { createBot } from "./ilink-client.js";
import { initDatabase } from "./db.js";
import { callClaude } from "./llm.js";
import { createConversationHandler } from "./conversation.js";
import { startServer, state } from "./server.js";

async function main() {
  console.log("iLink Bot 原型启动中...");

  // Initialize database
  const db = initDatabase();
  console.log("✓ SQLite 数据库已就绪");

  // Start web dashboard
  const server = startServer(db);

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
  bot.on("session:expired", () => {
    console.log("⚠ 会话已过期，需要重新扫码登录");
    state.botStatus = "waiting_qr";
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

main();
