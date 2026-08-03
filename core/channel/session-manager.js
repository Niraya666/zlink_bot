import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createBot } from "./wechat.js";
import { runQrLogin } from "./qr-login.js";
import { DATA_DIR } from "../paths.js";

const SESSIONS_DIR = path.join(DATA_DIR, "sessions");

// 二维码约 120 秒过期，SDK 最多自动换 3 张 ≈ 6 分钟。留些余量后回收未扫的会话，
// 否则每个只看一眼就离开的访客都会留下一个悬挂的 login() 和一份凭证目录。
const PENDING_TTL_MS = 8 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 1000;

/**
 * 会话状态机：
 *
 *   pending ──扫码确认──> bound ──session:expired/停止──> closed
 *      │                   │
 *      └── 超时/换码失败 ──> failed
 *
 * 一个会话 = 一个参与者 = 一个独立 WeChatBot 实例 + 一条长轮询。
 */
export function createSessionManager({ activity, db, handleMessage }) {
  const sessions = new Map();

  fs.mkdirSync(SESSIONS_DIR, { recursive: true });

  // 面向参与者的说法。原始报错只进服务端日志——普通人看到
  // "The operation was aborted due to timeout" 只会一头雾水。
  function friendlyError(raw) {
    if (!raw) return null;
    if (/过期未完成扫码/.test(raw)) return "二维码已超时，请重新开始";
    if (/已取消|服务停止/.test(raw)) return "连接已结束，请重新开始";
    if (/顶掉|失效/.test(raw)) return "这个微信号在别处重新连接了，请重新开始";
    if (/网络连续异常|HTTP \d+/.test(raw)) return "网络不太稳定，请重新开始";
    return "连接失败，请重新开始";
  }

  function publicView(s) {
    return {
      id: s.id,
      status: s.status,
      qrUrl: s.qrUrl,
      error: friendlyError(s.error),
      wechatUid: s.wechatUid,
    };
  }

  function closeSession(s, status, reason) {
    if (s.status === "closed" || s.status === "failed") return;
    s.status = status;
    s.error = reason ?? s.error;
    s.closedAt = Date.now();

    s.abort?.abort(); // 停掉还在跑的扫码轮询
    try {
      s.bot.stop();
    } catch {
      // 已经停了或从未启动，无所谓
    }
    // 凭证目录不再有用；留着只会随访客数无限增长。
    fs.rmSync(s.dir, { recursive: true, force: true });

    console.log(`[session ${s.id.slice(0, 8)}] ${status}${reason ? ` — ${reason}` : ""}`);
  }

  /**
   * 新建一个会话并申请二维码。
   *
   * 在拿到第一张二维码时就返回——login() 会一直阻塞到扫码确认为止，
   * 不能等它。确认之后的收尾在 .then() 里继续。
   */
  async function createSession() {
    const id = randomUUID();
    const dir = path.join(SESSIONS_DIR, id);

    const s = {
      id,
      dir,
      status: "pending",
      qrUrl: null,
      error: null,
      wechatUid: null,
      createdAt: Date.now(),
      boundAt: null,
      // 每个会话独立 storageDir：既互不覆盖，也不碰 ~/.wechatbot 的正式登录态
      bot: createBot({ storage: "file", storageDir: dir, logLevel: "warn" }),
    };
    sessions.set(id, s);

    s.abort = new AbortController();

    let firstQr;
    const gotFirstQr = new Promise((resolve, reject) => {
      firstQr = { resolve, reject };
    });

    // 参与者重复扫码会顶掉自己之前的绑定，服务端随即让旧会话失效。
    // 不回收的话，长轮询和实例会随重复扫码单调增长。
    s.bot.on("session:expired", () => closeSession(s, "closed", "会话被顶掉或失效"));
    s.bot.on("error", (err) => {
      console.error(`[session ${id.slice(0, 8)}] bot error: ${err.message}`);
    });

    s.bot.onMessage(async (msg) => {
      s.wechatUid ??= msg.userId;
      s.lastMessageAt = Date.now();
      await handleMessage(
        msg,
        (text) => s.bot.reply(msg, text),
        (on) =>
          on ? s.bot.sendTyping(msg.userId) : s.bot.stopTyping(msg.userId),
      );
    });

    // 用我们自己的扫码流程（见 qr-login.js：SDK 自带的那个超时设错了，
    // 参与者只要超过 15 秒没扫就会失败）。拿到凭证后写进 SDK 的 storage，
    // 再调 login() 就会直接读取、跳过扫码。
    runQrLogin({
      onQrUrl: (url) => {
        // 换新码时也会再次触发，页面轮询到新的 qrUrl 就会自动更新
        s.qrUrl = url;
        firstQr.resolve(url);
      },
      onScanned: () => {
        s.status = "scanned";
        console.log(`[session ${id.slice(0, 8)}] 已扫码，等待确认`);
      },
      signal: s.abort.signal,
    })
      .then(async (creds) => {
        await s.bot.storage.set("credentials", creds);
        await s.bot.login(); // 命中已存凭证，立即返回

        s.status = "bound";
        s.boundAt = Date.now();
        s.wechatUid = creds.userId;
        s.qrUrl = null; // 绑定后二维码没用了，别继续发给前端
        console.log(`[session ${id.slice(0, 8)}] ✓ 已绑定 ${s.wechatUid}`);
        await s.bot.start(); // 开始长轮询
      })
      .catch((err) => {
        s.qrUrl = null;
        closeSession(s, "failed", err.message);
        firstQr.reject(err);
      });

    // 只等第一张码；拿不到就说明连申请都失败了
    await gotFirstQr;
    return publicView(s);
  }

  function getSession(id) {
    const s = sessions.get(id);
    return s ? publicView(s) : null;
  }

  function stats() {
    const byStatus = {};
    for (const s of sessions.values()) {
      byStatus[s.status] = (byStatus[s.status] ?? 0) + 1;
    }
    return { total: sessions.size, byStatus };
  }

  // 定期清理：未扫码的过期会话、以及已关闭会话的记录
  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [id, s] of sessions) {
      const pendingTooLong =
        (s.status === "pending" || s.status === "scanned") &&
        now - s.createdAt > PENDING_TTL_MS;
      if (pendingTooLong) closeSession(s, "failed", "二维码超时未完成扫码");

      // 关闭超过十分钟的会话从表里移除，避免内存里越堆越多
      if ((s.status === "closed" || s.status === "failed") && now - (s.closedAt ?? 0) > 10 * 60 * 1000) {
        sessions.delete(id);
      }
    }
  }, SWEEP_INTERVAL_MS);
  sweeper.unref?.();

  function shutdown() {
    clearInterval(sweeper);
    for (const s of sessions.values()) closeSession(s, "closed", "服务停止");
    // 整个 sessions 目录都是一次性凭证，退出时清干净
    fs.rmSync(SESSIONS_DIR, { recursive: true, force: true });
  }

  return { createSession, getSession, stats, shutdown, activity, db };
}
