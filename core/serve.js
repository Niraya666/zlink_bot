import { initDatabase } from "./store/db.js";
import { callClaude } from "./engine/llm.js";
import { createConversationHandler } from "./engine/conversation.js";
import { loadCustomTools } from "./engine/custom-tools.js";
import { createSessionManager } from "./channel/session-manager.js";
import { startJoinServer } from "./dashboard/join.js";
import { startServer, state } from "./dashboard/server.js";

/**
 * 多会话模式：每个参与者各自扫码建立独立绑定。
 *
 * 与 run.js（单绑定）的区别只在 channel 层——engine、store、activity pack
 * 全部原样复用。两个 HTTP 服务刻意分开：
 *
 *   参与者页面 (join)  → 对外暴露，走隧道
 *   运营者控制台      → 只监听本地，永不对外
 */
/**
 * 兜底：任何一个参与者的网络抖动，都不该杀掉整个进程。
 *
 * 多会话模式下一个进程服务全部参与者——进程一死，所有人的会话同时断，
 * 且已绑定的人需要重新扫码。宁可带着异常继续跑，也不能让一个人的
 * ECONNRESET 掀掉整桌。日志打全，便于事后定位。
 */
function installCrashGuards() {
  process.on("unhandledRejection", (err) => {
    console.error(
      `⚠ 未处理的 Promise 异常（已忽略，服务继续）：${err?.message ?? err}`,
    );
    if (err?.stack) console.error(err.stack);
  });
  process.on("uncaughtException", (err) => {
    console.error(`⚠ 未捕获异常（已忽略，服务继续）：${err?.message ?? err}`);
    if (err?.stack) console.error(err.stack);
  });
}

export async function serveActivity(activity) {
  installCrashGuards();
  console.log(`活动：${activity.name}（${activity.slug}）`);

  const db = initDatabase({ eventId: activity.slug, eventName: activity.name });
  console.log("✓ SQLite 数据库已就绪");

  const customTools = await loadCustomTools(activity);
  if (customTools.length > 0) {
    console.log(
      `✓ 已加载 ${customTools.length} 个自定义工具：${customTools
        .map((t) => t.definition.name)
        .join("、")}`,
    );
  }

  // 对话处理器与用户无关（每条消息自己 getOrCreateUser），所有会话共用一个
  const handleMessage = createConversationHandler(db, callClaude, {
    slug: activity.slug,
    customTools,
  });

  const sessions = createSessionManager({ activity, db, handleMessage });

  const joinServer = startJoinServer(sessions, { port: activity.joinPort });

  // 控制台在多会话模式下没有"单个 bot 的登录状态"可言
  const console_ = startServer(db, {
    fields: activity.fields,
    eventName: activity.name,
    port: activity.webPort,
    summaryViewPath: activity.summaryViewPath,
  });
  state.botStatus = "running";

  console.log("");
  console.log("把参与者页面的公网地址发到群里，每个人点开都会拿到自己的二维码。");
  console.log("控制台只监听本地，不要把它暴露出去。");
  console.log("");

  // 每分钟报一次会话概况，方便小规模测试时观察
  const ticker = setInterval(() => {
    const s = sessions.stats();
    if (s.total > 0) {
      const detail = Object.entries(s.byStatus)
        .map(([k, v]) => `${k}=${v}`)
        .join(" ");
      console.log(`[会话] 共 ${s.total}  ${detail}`);
    }
  }, 60_000);
  ticker.unref?.();

  const shutdown = () => {
    console.log("\n正在关闭…");
    clearInterval(ticker);
    sessions.shutdown();
    joinServer.close();
    console_.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
