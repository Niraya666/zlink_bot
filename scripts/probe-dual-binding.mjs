#!/usr/bin/env node
// A2 双绑定验证 —— 回答 docs/multi-binding-findings.md §4 的三个问题：
//
//   Q1 服务端是否只认最后一个绑定？（B 确认后，A 是否被顶掉）
//   Q2 消息路由是否正确？（各自收到的消息能否区分来源、回复会不会串台）
//   Q3 并发绑定数是否有上限？（2 个只是起点，通过后再往上加）
//
// 需要两个微信号、两台手机（或一台手机 + 一个小号）。不调用 LLM，
// 因此不需要 .env / API key。
//
// 安全性：两个绑定各自使用 data/probe-bindings/{a,b} 作为 storageDir，
// 完全不碰 ~/.wechatbot/ 里的正式登录态。

import { WeChatBot } from "@wechatbot/wechatbot";
import qrcode from "qrcode";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "../core/paths.js";

const PROBE_DIR = path.join(DATA_DIR, "probe-bindings");
const KEEP = process.argv.includes("--keep");

const ts = () => new Date().toTimeString().slice(0, 8);
const log = (label, msg) => console.log(`[${ts()}] ${label ? `[${label}] ` : ""}${msg}`);

/** 每个绑定的观测记录，退出时汇总成结论。 */
function newRecord(label) {
  return {
    label,
    confirmedAt: null,
    messages: [], // { at, userId, text }
    errors: [], // { at, kind, message }
  };
}

function createBinding(label, record) {
  const dir = path.join(PROBE_DIR, label.toLowerCase());
  const bot = new WeChatBot({
    storage: "file",
    storageDir: dir, // 关键：每实例独立，互不覆盖
    logLevel: "warn", // 降噪，只看我们自己的日志
  });

  // session:expired 是 Q1 的核心信号 —— 如果 B 确认后 A 冒出这个，
  // 说明服务端只认最后一个绑定。
  bot.on("session:expired", () => {
    record.errors.push({ at: ts(), kind: "session:expired", message: "会话失效" });
    log(label, "🔴 session:expired —— 该绑定被判定失效（Q1 的关键信号）");
  });

  bot.on("session:restored", () => {
    log(label, "🟡 session:restored —— SDK 自动重登成功");
  });

  bot.on("error", (err) => {
    record.errors.push({ at: ts(), kind: "error", message: err.message });
    log(label, `🔴 error: ${err.message}`);
  });

  bot.onMessage(async (msg) => {
    record.messages.push({ at: ts(), userId: msg.userId, text: msg.text });
    log(label, `📩 收到消息  userId=${msg.userId}  内容="${msg.text.slice(0, 40)}"`);

    // 回一条带标签的消息：手机上看到 [A] 还是 [B]，直接暴露有没有串台。
    try {
      await bot.reply(msg, `[${label}] 收到：${msg.text.slice(0, 30)}`);
      log(label, `📤 已回复（请在手机上确认收到的是 [${label}]）`);
    } catch (err) {
      record.errors.push({ at: ts(), kind: "reply", message: err.message });
      log(label, `🔴 回复失败: ${err.message}`);
    }
  });

  return { bot, dir, label, record };
}

async function loginBinding(binding) {
  const { bot, label, record } = binding;

  log(label, "正在申请二维码…");

  await bot.login({
    callbacks: {
      // 注意：callbacks 必须传给 login()/run()，构造函数里的 loginCallbacks 会被 SDK 忽略。
      onQrUrl: async (url) => {
        const art = await qrcode.toString(url, { type: "terminal", small: true });
        console.log(`\n${"─".repeat(60)}`);
        console.log(`  绑定 ${label} 的二维码 —— 请用${label === "A" ? "第一个" : "第二个"}微信号扫描`);
        console.log(`  有效期约 120 秒，过期会自动换新（最多 3 张）`);
        console.log(`${"─".repeat(60)}`);
        console.log(art);
        console.log(`  扫不动就用这个链接：${url}\n`);
      },
      onScanned: () => log(label, "✓ 已扫码，请在手机上确认"),
      onExpired: () => log(label, "⚠ 上一张二维码已过期，正在换新…"),
    },
  });

  record.confirmedAt = ts();
  log(label, "✅ 绑定成功");
}

function summarize(records) {
  console.log(`\n${"═".repeat(60)}`);
  console.log("  观测汇总");
  console.log(`${"═".repeat(60)}`);

  for (const r of records) {
    console.log(`\n绑定 ${r.label}`);
    console.log(`  绑定成功于   : ${r.confirmedAt ?? "（未完成）"}`);
    console.log(`  收到消息数   : ${r.messages.length}`);
    const uids = [...new Set(r.messages.map((m) => m.userId))];
    console.log(`  消息来源 uid : ${uids.length ? uids.join(", ") : "（无）"}`);
    console.log(`  异常数       : ${r.errors.length}`);
    for (const e of r.errors) console.log(`    - ${e.at} [${e.kind}] ${e.message}`);
  }

  const [a, b] = records;
  const bothBound = a.confirmedAt && b.confirmedAt;
  const expired = records.filter((r) => r.errors.some((e) => e.kind === "session:expired"));
  const bothGotMsg = a.messages.length > 0 && b.messages.length > 0;
  const uidA = new Set(a.messages.map((m) => m.userId));
  const uidB = new Set(b.messages.map((m) => m.userId));
  const overlap = [...uidA].filter((u) => uidB.has(u));

  console.log(`\n${"─".repeat(60)}`);
  console.log("  结论");
  console.log(`${"─".repeat(60)}`);

  console.log(`\nQ1 两个绑定能否共存？`);
  if (!bothBound) {
    console.log("   ⚠ 未完成两次绑定，无法判定（请两个号都扫完再退出）");
  } else if (expired.length === 0) {
    console.log("   ✅ 两个绑定都未出现 session:expired —— 服务端允许共存");
  } else {
    console.log(`   ❌ 绑定 ${expired.map((r) => r.label).join("、")} 出现 session:expired`);
    console.log("      → 服务端可能只认最后一个绑定，「一 bot 多人」不成立");
  }

  console.log(`\nQ2 消息路由是否正确？`);
  if (!bothGotMsg) {
    console.log("   ⚠ 至少一个绑定没收到消息，无法判定（请两个号各发一条再退出）");
  } else if (overlap.length === 0) {
    console.log("   ✅ 两边收到的 userId 完全不重叠 —— 路由正确、无串台");
  } else {
    console.log(`   ❌ userId ${overlap.join("、")} 同时出现在两个绑定 —— 存在串台`);
  }
  console.log("   （还需你在手机上确认：每个号收到的回复标签与自己扫的绑定一致）");

  console.log(`\nQ3 并发上限？`);
  console.log("   本脚本只测 2 个。若 Q1/Q2 通过，把 LABELS 加到 5、10、20 再跑，");
  console.log("   逐步逼近真实活动规模（300 人）。\n");

  if (!KEEP) {
    fs.rmSync(PROBE_DIR, { recursive: true, force: true });
    console.log(`已清理 ${PROBE_DIR}（下次重新扫码；加 --keep 可保留）\n`);
  } else {
    console.log(`已保留 ${PROBE_DIR}（下次运行会复用凭证、跳过扫码）\n`);
  }
}

// 提到模块作用域：信号处理和顶层异常都要能走到汇总，
// 否则中途 Ctrl-C 或一次网络抖动就会丢掉全部观测记录。
const records = [newRecord("A"), newRecord("B")];
let bindings = [];
let done = false;

function finish(reason) {
  if (done) return;
  done = true;
  if (reason) console.log(`\n\n${reason}`);
  for (const b of bindings) {
    try {
      b.bot.stop();
    } catch {}
  }
  summarize(records);
  process.exit(0);
}

process.on("SIGINT", () => finish("正在停止…"));
process.on("SIGTERM", () => finish("正在停止…"));

async function main() {
  console.log("\n双绑定验证 —— 需要两个微信号\n");

  // 默认每次从零开始：留着旧凭证会直接跳过扫码，就测不到绑定流程了。
  if (!KEEP && fs.existsSync(PROBE_DIR)) {
    fs.rmSync(PROBE_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(PROBE_DIR, { recursive: true });

  bindings = records.map((r) => createBinding(r.label, r));

  console.log(`凭证目录：${bindings.map((b) => b.dir).join("  ")}`);
  console.log("（不会碰 ~/.wechatbot/ 里的正式登录态）\n");

  // 串行绑定：这既好操作（一次扫一个），也更贴近真实场景
  // ——参与者是先后接入的，正好能观察 B 接入时 A 是否被顶掉。
  await loginBinding(bindings[0]);

  log("A", "开始长轮询…");
  bindings[0].bot.start().catch((err) => {
    records[0].errors.push({ at: ts(), kind: "start", message: err.message });
    log("A", `🔴 轮询启动失败: ${err.message}`);
  });

  console.log("\n>>> 关键观察点：接下来 B 绑定时，留意 A 会不会冒出 session:expired <<<\n");

  await loginBinding(bindings[1]);

  log("B", "开始长轮询…");
  bindings[1].bot.start().catch((err) => {
    records[1].errors.push({ at: ts(), kind: "start", message: err.message });
    log("B", `🔴 轮询启动失败: ${err.message}`);
  });

  console.log(`\n${"═".repeat(60)}`);
  console.log("  两个绑定都已就绪，现在请：");
  console.log("");
  console.log("  1. 用第一个微信号给它的 ClawBot 发一条消息");
  console.log("  2. 用第二个微信号给它的 ClawBot 发一条消息");
  console.log("  3. 确认各自收到的回复标签是 [A] / [B] 且没有串台");
  console.log("  4. 观察几分钟，看有没有一方掉线");
  console.log("");
  console.log("  观测完毕按 Ctrl-C 退出，会打印结论汇总。");
  console.log(`${"═".repeat(60)}\n`);
}

main().catch((err) => {
  // 走到这里最常见的两种情况：用户中断，或 pollQrStatus 撞上网络超时
  //（该接口单次会挂起约 45 秒，抖一下就抛）。无论哪种都要汇总已有观测，
  // 不能让记录随异常一起丢掉。
  const aborted = /abort|timeout/i.test(err.message);
  finish(
    aborted
      ? `⚠ 登录过程被中断或网络超时：${err.message}\n（若非你主动中断，直接重跑一次即可）`
      : `❌ 失败：${err.message}`,
  );
});
