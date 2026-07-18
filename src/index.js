import { createBot } from "./ilink-client.js";
import { initDatabase } from "./db.js";
import { callClaude } from "./llm.js";
import { createConversationHandler } from "./conversation.js";

async function main() {
  console.log("iLink Bot 原型启动中...");

  // Initialize database
  const db = initDatabase();
  console.log("✓ SQLite 数据库已就绪");

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

  // Handle session expiry
  bot.on("session:expired", () => {
    console.log("⚠ 会话已过期，需要重新扫码登录");
  });

  bot.on("error", (err) => {
    console.error("Bot error:", err.message);
  });

  // Start (login + poll)
  try {
    console.log("正在登录 iLink...");
    await bot.run();
    console.log("✓ 已登录并开始接收消息");
  } catch (err) {
    console.error("启动失败:", err.message);
    process.exit(1);
  }

  // Graceful shutdown
  process.on("SIGINT", async () => {
    console.log("\n正在关闭...");
    await bot.stop();
    process.exit(0);
  });
}

main();
