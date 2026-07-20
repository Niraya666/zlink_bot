import http from "node:http";
import qrcode from "qrcode";

const PORT = process.env.WEB_PORT || 3000;

// Shared state — written by index.js, read by server
export const state = {
  // "starting" | "waiting_qr" | "running" | "session_expired" | "error"
  botStatus: "starting",
  qrUrl: null,
  errorMessage: null,
};

/**
 * @param db      activity-scoped database (see initDatabase)
 * @param options.fields    field schema `[{ key, label }]` — drives table columns
 * @param options.eventName activity name shown in the header
 */
export function startServer(db, options = {}) {
  const fields = options.fields || [];
  const eventName = options.eventName || "";

  const server = http.createServer(async (req, res) => {
    // CORS for local dev
    res.setHeader("Access-Control-Allow-Origin", "*");

    try {
      const url = new URL(req.url, `http://localhost:${PORT}`);

      if (url.pathname === "/") {
        serveDashboard(res, { fields, eventName });
      } else if (url.pathname === "/api/status") {
        serveStatus(res);
      } else if (url.pathname === "/api/users") {
        serveUsers(db, res);
      } else if (url.pathname === "/api/qrcode") {
        await serveQrCode(url, res);
      } else {
        res.writeHead(404);
        res.end("Not Found");
      }
    } catch (err) {
      console.error("Server error:", err.message);
      res.writeHead(500);
      res.end("Internal Server Error");
    }
  });

  server.listen(PORT, () => {
    console.log(`✓ 网页控制台已启动: http://localhost:${PORT}`);
  });

  return server;
}

function serveStatus(res) {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      botStatus: state.botStatus,
      qrUrl: state.qrUrl,
      error: state.errorMessage,
    }),
  );
}

function serveUsers(db, res) {
  const rows = db.getUserSummaries();

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(rows));
}

async function serveQrCode(url, res) {
  const qrUrl = url.searchParams.get("url");
  if (!qrUrl) {
    res.writeHead(400);
    res.end("Missing ?url= parameter");
    return;
  }

  const dataUrl = await qrcode.toDataURL(qrUrl, {
    width: 280,
    margin: 2,
    color: { dark: "#1a1a2e", light: "#ffffff" },
  });

  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end(dataUrl);
}

function serveDashboard(res, { fields, eventName }) {
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>iLink Bot 控制台</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0f0f1a; color: #e0e0e0; min-height: 100vh; }
  .container { max-width: 960px; margin: 0 auto; padding: 32px 20px; }
  h1 { font-size: 24px; font-weight: 600; margin-bottom: 8px; }
  .subtitle { color: #888; font-size: 14px; margin-bottom: 32px; }
  .status-bar { display: flex; align-items: center; gap: 12px; padding: 16px 20px; border-radius: 12px; margin-bottom: 32px; background: #1a1a2e; }
  .status-dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }
  .status-dot.online { background: #4ade80; box-shadow: 0 0 8px #4ade8088; }
  .status-dot.waiting { background: #facc15; box-shadow: 0 0 8px #facc1588; animation: pulse 1.5s infinite; }
  .status-dot.error { background: #f87171; }
  .status-dot.offline { background: #666; }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
  .status-text { font-size: 14px; }
  .status-text small { color: #888; }

  .qr-section { display: none; background: #1a1a2e; border-radius: 12px; padding: 24px; margin-bottom: 32px; text-align: center; }
  .qr-section.show { display: block; }
  .qr-section h2 { font-size: 16px; margin-bottom: 8px; }
  .qr-section p { color: #888; font-size: 13px; margin-bottom: 20px; }
  .qr-section img { border-radius: 8px; background: #fff; padding: 12px; }
  .qr-url { margin-top: 12px; font-size: 12px; color: #666; word-break: break-all; }

  .section-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
  .section-header h2 { font-size: 18px; }
  .badge { background: #4ade8022; color: #4ade80; padding: 4px 10px; border-radius: 20px; font-size: 13px; }

  table { width: 100%; border-collapse: collapse; background: #1a1a2e; border-radius: 12px; overflow: hidden; }
  th { text-align: left; padding: 12px 16px; font-size: 12px; color: #888; text-transform: uppercase; letter-spacing: 0.5px; border-bottom: 1px solid #2a2a3e; }
  td { padding: 14px 16px; font-size: 14px; border-bottom: 1px solid #2a2a3e; }
  tr:last-child td { border-bottom: none; }
  .tag { display: inline-block; padding: 2px 10px; border-radius: 20px; font-size: 12px; }
  .tag.bound { background: #3b82f622; color: #60a5fa; }
  .tag.completed { background: #4ade8022; color: #4ade80; }
  .tag.dropped { background: #f8717122; color: #f87171; }
  .empty-state { text-align: center; padding: 48px 20px; color: #666; }
  .empty-state .icon { font-size: 40px; margin-bottom: 12px; }
  .refresh { font-size: 12px; color: #666; margin-top: 8px; text-align: right; }
</style>
</head>
<body>
<div class="container">
  <h1>iLink Bot 控制台</h1>
  <p class="subtitle">${eventName ? eventName + " · " : ""}活动报名 · 实时概览</p>

  <div class="status-bar">
    <div class="status-dot" id="statusDot"></div>
    <div class="status-text" id="statusText">连接中...</div>
  </div>

  <div class="qr-section" id="qrSection">
    <h2>扫码绑定机器人</h2>
    <p>首次使用请用微信扫描下方二维码</p>
    <img id="qrImage" src="" alt="QR Code" />
    <div class="qr-url" id="qrUrl"></div>
  </div>

  <div class="section-header">
    <h2>报名用户</h2>
    <span class="badge" id="userCount">0 人</span>
  </div>

  <div id="userTable"></div>
  <p class="refresh">数据每 5 秒自动刷新</p>
</div>

<script>
// Column schema, injected at serve time — the table follows the activity's
// field list, so adding or renaming a field needs no code change here.
const FIELDS = ${JSON.stringify(fields)};

const STATUS_MAP = {
  starting:       { dot: "waiting", text: "正在启动..." },
  waiting_qr:     { dot: "waiting", text: "等待扫码绑定 — 请用微信扫描下方二维码" },
  running:        { dot: "online",  text: "机器人已在线，正在接收消息" },
  session_expired:{ dot: "error",   text: "登录已失效 — 请查看终端二维码重新扫码，或运行 npm run relogin 后重启" },
  error:          { dot: "error",   text: "" },
};

async function refresh() {
  try {
    const [statusRes, usersRes] = await Promise.all([
      fetch("/api/status"),
      fetch("/api/users")
    ]);
    const status = await statusRes.json();
    const users = await usersRes.json();

    // Status
    const s = STATUS_MAP[status.botStatus] || STATUS_MAP.starting;
    const dot = document.getElementById("statusDot");
    dot.className = "status-dot " + s.dot;
    const text = status.botStatus === "error"
      ? "错误: " + (status.error || "未知错误")
      : s.text;
    document.getElementById("statusText").innerHTML = text + ' <small>' + new Date().toLocaleTimeString() + '</small>';

    // QR section
    const qrSection = document.getElementById("qrSection");
    if (status.botStatus === "waiting_qr" && status.qrUrl) {
      qrSection.classList.add("show");
      document.getElementById("qrUrl").textContent = status.qrUrl;
      fetch("/api/qrcode?url=" + encodeURIComponent(status.qrUrl))
        .then(r => r.text())
        .then(dataUrl => { document.getElementById("qrImage").src = dataUrl; });
    } else {
      qrSection.classList.remove("show");
    }

    // Users
    document.getElementById("userCount").textContent = users.length + " 人";
    if (users.length === 0) {
      document.getElementById("userTable").innerHTML =
        '<div class="empty-state"><div class="icon">📋</div>还没有用户数据，等待第一条消息...</div>';
    } else {
      let html = '<table><thead><tr><th>微信 UID</th>' +
        FIELDS.map(f => '<th>' + esc(f.label) + '</th>').join('') +
        '<th>状态</th><th>创建时间</th></tr></thead><tbody>';
      for (const u of users) {
        const statusTag = u.status === "completed" ? "completed" : u.status === "dropped" ? "dropped" : "bound";
        const statusLabel = u.status === "completed" ? "已完成" : u.status === "dropped" ? "已放弃" : "对话中";
        const collected = u.collected || {};
        html += '<tr>' +
          '<td>' + esc(u.wechat_uid) + '</td>' +
          FIELDS.map(f => '<td>' + esc(collected[f.key] || "-") + '</td>').join('') +
          '<td><span class="tag ' + statusTag + '">' + statusLabel + '</span></td>' +
          '<td>' + esc(u.created_at || "") + '</td>' +
          '</tr>';
      }
      html += '</tbody></table>';
      document.getElementById("userTable").innerHTML = html;
    }
  } catch (err) {
    console.error("Refresh error:", err);
  }
}

function esc(s) {
  if (!s) return "";
  return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

refresh();
setInterval(refresh, 5000);
</script>
</body>
</html>`;

  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}
