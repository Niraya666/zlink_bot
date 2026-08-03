import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

// ─────────────────────────────────────────────────────────────────────────────
// 为什么不用 SDK 自带的 bot.login()
//
// SDK 的 pollQrStatus 调 apiGet 时没有覆盖超时，用的是 15 秒默认值；
// 而服务端 get_qrcode_status 是长轮询，会挂起约 45 秒才返回。
// 其 qrLogin 轮询循环又没有 try/catch，于是：
//
//   任何超过 ~15 秒才扫码的会话，login() 必然抛 TimeoutError 而彻底失败。
//
// 双绑定测试之所以成功，只是因为人扫得快，服务端在扫码瞬间就返回了。
// 真实活动里没人能在 15 秒内扫完，所以必须自己实现这段流程。
//
// 这里只用 fetch 直接打两个端点，请求头是两个静态值（见 SDK headers.js），
// 因此不依赖 SDK 任何内部结构，SDK 升级也不会碎。
// ─────────────────────────────────────────────────────────────────────────────

const BASE = "https://ilinkai.weixin.qq.com";

// 必须大于服务端约 45 秒的挂起时间，否则每次轮询都会自己超时
const POLL_TIMEOUT_MS = 60_000;
const QR_REQUEST_TIMEOUT_MS = 15_000;

// 二维码约 120 秒过期。给足换码次数，让参与者有从容扫码的窗口。
const MAX_QR_REFRESH = 3;
// 连续网络异常多少次后才判定失败——单次抖动不该让参与者的会话报废
const MAX_CONSECUTIVE_ERRORS = 5;

/**
 * 客户端版本号取自 SDK 的 package.json，与 SDK 自己发出的请求保持一致。
 * 该包的 exports 不允许 require('.../package.json')，所以先 resolve 入口
 * （"." 是导出的）再用 fs 读上一级目录。
 */
const CLIENT_VERSION = (() => {
  try {
    const require = createRequire(import.meta.url);
    const entry = require.resolve("@wechatbot/wechatbot"); // → .../dist/index.js
    const pkgPath = path.join(path.dirname(entry), "..", "package.json");
    const { version } = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
    const [maj = 0, min = 0, pat = 0] = version.split(".").map((n) => parseInt(n, 10) || 0);
    // uint32 编码为 0x00MMNNPP
    return String(((maj & 0xff) << 16) | ((min & 0xff) << 8) | (pat & 0xff));
  } catch {
    return "131072"; // 2.0.0，读不到时的兜底
  }
})();

const COMMON_HEADERS = {
  "iLink-App-Id": "bot",
  "iLink-App-ClientVersion": CLIENT_VERSION,
};

function commonHeaders() {
  return COMMON_HEADERS;
}

async function post(path, body, timeoutMs) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...commonHeaders() },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function get(path, timeoutMs) {
  const res = await fetch(`${BASE}${path}`, {
    headers: commonHeaders(),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

const isAbort = (err) =>
  err?.name === "TimeoutError" || err?.name === "AbortError" || /abort|timeout/i.test(err?.message ?? "");

/**
 * 走完一次扫码登录，返回可直接写入 SDK storage 的 credentials。
 *
 * @param onQrUrl   每次拿到新二维码时调用（含换码）
 * @param onScanned 已扫码、等待手机确认时调用
 * @param signal    AbortSignal，用于会话被清理时取消
 */
export async function runQrLogin({ onQrUrl, onScanned, signal } = {}) {
  for (let attempt = 1; attempt <= MAX_QR_REFRESH; attempt++) {
    if (signal?.aborted) throw new Error("已取消");

    const qr = await post(
      "/ilink/bot/get_bot_qrcode?bot_type=3",
      { local_token_list: [] }, // 传空：带上已有 token 会走 binded_redirect 复用旧绑定
      QR_REQUEST_TIMEOUT_MS,
    );
    if (!qr?.qrcode) throw new Error("服务端未返回二维码");

    onQrUrl?.(qr.qrcode_img_content);

    let lastStatus = null;
    let consecutiveErrors = 0;

    // 轮询这张码，直到确认、过期，或连续异常过多
    for (;;) {
      if (signal?.aborted) throw new Error("已取消");

      let s;
      try {
        s = await get(
          `/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qr.qrcode)}`,
          POLL_TIMEOUT_MS,
        );
        consecutiveErrors = 0;
      } catch (err) {
        // 这里正是 SDK 会直接放弃的地方。网络抖动、偶发超时都不该让
        // 参与者的会话报废——继续重试，只有连续多次才认输。
        if (++consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          throw new Error(`网络连续异常 ${consecutiveErrors} 次：${err.message}`);
        }
        if (!isAbort(err)) await new Promise((r) => setTimeout(r, 2000));
        continue;
      }

      if (s.status !== lastStatus) {
        lastStatus = s.status;
        if (s.status === "scaned") onScanned?.();
      }

      if (s.status === "confirmed") {
        if (!s.bot_token || !s.ilink_bot_id || !s.ilink_user_id) {
          throw new Error("确认成功但服务端未返回完整凭证");
        }
        // 形状与 SDK 的 Credentials 一致，可直接写进它的 storage
        return {
          token: s.bot_token,
          baseUrl: s.baseurl ?? BASE,
          accountId: s.ilink_bot_id,
          userId: s.ilink_user_id,
          savedAt: new Date().toISOString(),
        };
      }

      if (s.status === "expired") break; // 外层换一张新码

      if (s.status === "binded_redirect") {
        throw new Error("该微信号已绑定到本客户端，请稍后重试");
      }

      // scaned_but_redirect 等中间态：稍等再轮询
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  throw new Error(`二维码连续 ${MAX_QR_REFRESH} 次过期未完成扫码`);
}
