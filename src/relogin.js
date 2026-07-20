// Reset the saved WeChat login so the next `npm start` shows a fresh QR code.
//
// Why this exists: the @wechatbot/wechatbot SDK persists login credentials to
// ~/.wechatbot/ (storage: "file"). On every subsequent run it silently reuses
// them and skips the QR flow. That's the intended "remember me" behavior — but
// when the saved session has expired, or you want to bind a different WeChat
// account, there is no built-in way to force a fresh scan. This clears the saved
// state so login starts from scratch.

import { rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

// Must match FileStorage's default dir in the SDK (os.homedir()/.wechatbot).
// Override with WECHATBOT_STORAGE_DIR if you ever point the SDK elsewhere.
const STORAGE_DIR =
  process.env.WECHATBOT_STORAGE_DIR || path.join(os.homedir(), ".wechatbot");

// The keys FileStorage writes, one JSON file each (see SDK STORAGE_KEYS).
const FILES = [
  "credentials.json", // the login itself — deleting this forces a new QR
  "cursor.json", // poll cursor — reset so we don't replay a dead session
  "context_tokens.json", // per-conversation reply tokens — stale after rebind
  "typing_tickets.json", // typing indicators — harmless to drop
];

async function main() {
  let removed = 0;
  for (const file of FILES) {
    const target = path.join(STORAGE_DIR, file);
    try {
      await rm(target, { force: true });
      removed++;
    } catch (err) {
      console.error(`删除 ${target} 失败: ${err.message}`);
    }
  }
  console.log(`✓ 已清除 ${STORAGE_DIR} 下的登录态（${removed} 个文件）`);
  console.log("下次运行 npm start 会重新显示二维码，请用微信扫码绑定。");
}

main();
