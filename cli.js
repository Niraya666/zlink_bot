#!/usr/bin/env node
import {
  loadActivity,
  resolveActivitySlug,
  listActivitySlugs,
} from "./core/activity.js";
import { initDatabase } from "./core/store/db.js";
import { runActivity } from "./core/run.js";
import { clearSavedLogin } from "./core/channel/session.js";

const USAGE = `zlink — 活动报名机器人

用法：
  zlink run [活动]              启动活动（只有一个活动时可省略）
  zlink list                    列出所有活动及报名统计
  zlink export <活动> [--csv]   导出报名数据（默认 JSON）
  zlink relogin                 清除微信登录态，下次启动重新扫码

示例：
  zlink run demo-day-2026
  zlink export demo-day-2026 --csv > signups.csv
`;

async function cmdRun(args) {
  const activity = loadActivity(resolveActivitySlug(args[0]));
  console.log("iLink Bot 启动中...");
  await runActivity(activity);
}

async function cmdList() {
  const slugs = listActivitySlugs();
  if (slugs.length === 0) {
    console.log("activities/ 下没有活动。用 new-activity skill 创建一个。");
    return;
  }

  for (const slug of slugs) {
    let activity;
    try {
      activity = loadActivity(slug);
    } catch (err) {
      console.log(`✗ ${slug} — 配置有误`);
      console.log(
        err.message
          .split("\n")
          .slice(1)
          .map((l) => `  ${l.trim()}`)
          .join("\n"),
      );
      continue;
    }

    // Each activity's rows live in the same file, scoped by event id.
    const db = initDatabase({ eventId: slug, eventName: activity.name });
    const users = db.getUserSummaries();
    const done = users.filter((u) => u.status === "completed").length;

    console.log(`● ${slug} — ${activity.name}`);
    console.log(
      `    字段 ${activity.fields.length}（必收 ${activity.requiredFields.length}）` +
        ` · 报名 ${users.length} 人 · 已完成 ${done} 人` +
        (activity.webPort ? ` · 端口 ${activity.webPort}` : ""),
    );
  }
}

function toCsv(activity, users) {
  const headers = ["wechat_uid", ...activity.fields.map((f) => f.key), "status", "created_at"];
  const labels = ["微信 UID", ...activity.fields.map((f) => f.label), "状态", "创建时间"];

  const escape = (v) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  const rows = users.map((u) =>
    [
      u.wechat_uid,
      ...activity.fields.map((f) => u.collected[f.key] ?? ""),
      u.status,
      u.created_at,
    ]
      .map(escape)
      .join(","),
  );

  // Header row uses labels; the key row keeps the export machine-readable.
  return [labels.map(escape).join(","), ...rows].join("\n") + "\n";
}

async function cmdExport(args) {
  const asCsv = args.includes("--csv");
  const slug = resolveActivitySlug(args.find((a) => !a.startsWith("--")));
  const activity = loadActivity(slug);

  const db = initDatabase({ eventId: slug, eventName: activity.name });
  const users = db.getUserSummaries();

  if (asCsv) {
    process.stdout.write(toCsv(activity, users));
  } else {
    process.stdout.write(
      JSON.stringify(
        {
          activity: { slug, name: activity.name },
          fields: activity.fields,
          users,
        },
        null,
        2,
      ) + "\n",
    );
  }
}

async function cmdRelogin() {
  const { dir, removed } = await clearSavedLogin();
  if (removed.length === 0) {
    console.log(`${dir} 下没有已保存的登录态，下次启动本来就会显示二维码。`);
    return;
  }
  console.log(`✓ 已清除 ${dir} 下的登录态（${removed.join("、")}）`);
  console.log("下次运行 zlink run 会重新显示二维码，请用微信扫码绑定。");
}

const COMMANDS = {
  run: cmdRun,
  list: cmdList,
  export: cmdExport,
  relogin: cmdRelogin,
};

async function main() {
  const [command, ...args] = process.argv.slice(2);

  if (!command || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(USAGE);
    return;
  }

  const handler = COMMANDS[command];
  if (!handler) {
    console.error(`未知命令：${command}\n`);
    process.stdout.write(USAGE);
    process.exit(1);
  }

  await handler(args);
}

// Pack loading / validation errors are user-facing config problems —
// show the message, not a stack trace.
main().catch((err) => {
  console.error(`\n${err.message}\n`);
  process.exit(1);
});
