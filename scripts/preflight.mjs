#!/usr/bin/env node
// 部署前自检：一条命令报告环境还缺什么。
//
// 设计目标是给远程操作用（比如通过 OpenClaw 在够不着的机器上执行）——
// 与其照着文档一步步猜哪里不对，不如让机器自己说。
//
//   node scripts/preflight.mjs [活动slug]
//
// 不打印任何密钥值，只报告存在与否。

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import net from "node:net";
import { createRequire } from "node:module";
import { PROJECT_ROOT, DATA_DIR } from "../core/paths.js";

const slug = process.argv[2] || null;
const results = [];

const ok = (name, detail) => results.push({ level: "ok", name, detail });
const warn = (name, detail, fix) => results.push({ level: "warn", name, detail, fix });
const bad = (name, detail, fix) => results.push({ level: "bad", name, detail, fix });

// ── Node 版本 ────────────────────────────────────────────────────────
{
  const [maj, min] = process.versions.node.split(".").map(Number);
  const enough = maj > 22 || (maj === 22 && min >= 5);
  const msg = `v${process.versions.node}`;
  if (enough) ok("Node 版本", msg);
  else
    bad(
      "Node 版本",
      `${msg}，需要 ≥ 22.5（node:sqlite 依赖它）`,
      "brew install node  或  https://nodejs.org 下载 LTS",
    );
}

// ── 依赖是否装好 ─────────────────────────────────────────────────────
{
  const require = createRequire(import.meta.url);
  const deps = Object.keys(
    JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, "package.json"), "utf-8"))
      .dependencies ?? {},
  );
  const missing = deps.filter((d) => {
    try {
      require.resolve(d);
      return false;
    } catch {
      return true;
    }
  });
  if (missing.length === 0) ok("依赖", `${deps.length} 个包已安装`);
  else bad("依赖", `缺 ${missing.join("、")}`, "npm install");
}

// ── .env ────────────────────────────────────────────────────────────
{
  const envPath = path.join(PROJECT_ROOT, ".env");
  if (!fs.existsSync(envPath)) {
    bad(
      ".env",
      "不存在（它不在 git 里，必须手工传）",
      "从你的笔记本执行： scp .env <这台机器>:" + PROJECT_ROOT + "/.env",
    );
  } else {
    // 只看 key 名，绝不打印值
    const names = fs
      .readFileSync(envPath, "utf-8")
      .split("\n")
      .map((l) => l.split("=")[0].trim())
      .filter(Boolean);
    const needed = ["DEEPSEEK_API_KEY"];
    const lack = needed.filter((n) => !names.includes(n));
    if (lack.length === 0) ok(".env", `已配置 ${names.length} 项`);
    else bad(".env", `缺少 ${lack.join("、")}`, "补齐后重试");

    const mode = (fs.statSync(envPath).mode & 0o777).toString(8);
    if (mode !== "600") warn(".env 权限", `当前 ${mode}`, `chmod 600 ${envPath}`);
  }
}

// ── data 目录可写 ────────────────────────────────────────────────────
{
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const probe = path.join(DATA_DIR, ".preflight");
    fs.writeFileSync(probe, "x");
    fs.rmSync(probe);
    ok("data/ 可写", DATA_DIR);
  } catch (err) {
    bad("data/ 可写", err.message, "检查目录权限");
  }
}

// ── 活动 pack ───────────────────────────────────────────────────────
let activity = null;
{
  try {
    const { loadActivity, listActivitySlugs } = await import("../core/activity.js");
    const slugs = listActivitySlugs();
    if (slugs.length === 0) {
      bad("活动 pack", "activities/ 下没有活动", "用 new-activity skill 创建");
    } else if (slug) {
      if (!slugs.includes(slug)) {
        bad("活动 pack", `找不到 ${slug}`, `已有：${slugs.join("、")}`);
      } else {
        activity = loadActivity(slug);
        ok("活动 pack", `${slug} — ${activity.name}（必收 ${activity.requiredFields.length} 项）`);
      }
    } else {
      ok("活动 pack", `${slugs.length} 个：${slugs.join("、")}`);
      warn("未指定活动", "多活动时启动必须带 slug", `node scripts/preflight.mjs <slug>`);
    }
  } catch (err) {
    bad("活动 pack", err.message.split("\n")[0], "按报错修正配置文件");
  }
}

// ── 端口占用 ────────────────────────────────────────────────────────
async function portFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", () => resolve(false));
    s.once("listening", () => s.close(() => resolve(true)));
    s.listen(port, "0.0.0.0");
  });
}
{
  const joinPort = activity?.joinPort ?? 3001;
  const webPort = activity?.webPort ?? 3000;
  for (const [name, port] of [
    ["参与者页面", joinPort],
    ["运营者控制台", webPort],
  ]) {
    if (await portFree(port)) ok(`端口 ${port}`, `${name} 可用`);
    else
      warn(
        `端口 ${port}`,
        `${name} 已被占用（可能是上一次没停干净）`,
        `lsof -nP -iTCP:${port} -sTCP:LISTEN   然后 kill -TERM <PID>`,
      );
  }
}

// ── cloudflared ─────────────────────────────────────────────────────
{
  try {
    const v = execSync("cloudflared --version 2>&1", { encoding: "utf-8" }).trim();
    ok("cloudflared", v.split("\n")[0]);
  } catch {
    warn(
      "cloudflared",
      "未安装（对外开放才需要，只在本机测试可忽略）",
      "brew install cloudflared",
    );
  }
}

// ── 到微信服务器的连通性 ──────────────────────────────────────────────
{
  try {
    const res = await fetch("https://ilinkai.weixin.qq.com/", {
      signal: AbortSignal.timeout(8000),
    });
    ok("微信服务器连通", `HTTP ${res.status}（404 属正常，说明能连上）`);
  } catch (err) {
    bad("微信服务器连通", err.message, "检查网络；没有它扫码和收发消息都不可用");
  }
}

// ── 输出 ────────────────────────────────────────────────────────────
const icon = { ok: "✅", warn: "⚠️ ", bad: "❌" };
console.log(`\n部署前自检 — ${PROJECT_ROOT}\n`);
for (const r of results) {
  console.log(`${icon[r.level]} ${r.name}：${r.detail}`);
  if (r.fix) console.log(`     → ${r.fix}`);
}

const bads = results.filter((r) => r.level === "bad").length;
const warns = results.filter((r) => r.level === "warn").length;
console.log("");
if (bads > 0) {
  console.log(`❌ ${bads} 项必须解决才能启动${warns ? `，另有 ${warns} 项提醒` : ""}`);
  process.exit(1);
}
console.log(`✅ 环境就绪${warns ? `（${warns} 项提醒，不阻塞启动）` : ""}`);
console.log("\n下一步：");
console.log(`  node scripts/probe-dual-binding.mjs      # 上线前的双绑定验证`);
console.log(`  node --env-file=.env cli.js serve ${slug ?? "<slug>"}`);
