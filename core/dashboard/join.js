import http from "node:http";
import qrcode from "qrcode";

const DEFAULT_PORT = 3001;

/**
 * 参与者页面 —— 这是唯一对外暴露（走隧道）的服务。
 *
 * 与运营者控制台（dashboard/server.js）**刻意分成两个进程端口**：
 * 控制台会漏出报名数据和登录二维码，永远不该出现在公网上。
 * 这里只有三个端点，且不返回任何其他参与者的信息。
 */
export function startJoinServer(sessionManager, options = {}) {
  const PORT = Number(process.env.JOIN_PORT) || options.port || DEFAULT_PORT;
  const activity = sessionManager.activity;

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://localhost:${PORT}`);

      if (url.pathname === "/" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderPage(activity));
        return;
      }

      // 建会话是有副作用的（申请二维码、起一个绑定），必须用 POST，
      // 否则微信/浏览器的预取就会凭空造出一堆会话。
      if (url.pathname === "/api/session" && req.method === "POST") {
        const session = await sessionManager.createSession();
        json(res, 201, session);
        return;
      }

      const m = url.pathname.match(/^\/api\/session\/([\w-]+)$/);
      if (m && req.method === "GET") {
        const session = sessionManager.getSession(m[1]);
        if (!session) {
          json(res, 404, { error: "会话不存在或已过期" });
          return;
        }
        json(res, 200, session);
        return;
      }

      if (url.pathname === "/api/qrcode" && req.method === "GET") {
        const target = url.searchParams.get("url");
        // 只允许渲染 iLink 的登录链接，避免被当成任意二维码生成器（钓鱼图床）
        if (!target || !target.startsWith("https://liteapp.weixin.qq.com/")) {
          res.writeHead(400);
          res.end("Bad url");
          return;
        }
        const dataUrl = await qrcode.toDataURL(target, { width: 280, margin: 2 });
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end(dataUrl);
        return;
      }

      res.writeHead(404);
      res.end("Not Found");
    } catch (err) {
      console.error("Join server error:", err.message);
      json(res, 500, { error: "服务暂时不可用，请稍后重试" });
    }
  });

  server.listen(PORT, () => {
    console.log(`✓ 参与者页面已启动: http://localhost:${PORT}  ← 隧道指向这个端口`);
  });

  return server;
}

function json(res, code, body) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function renderPage(activity) {
  const name = escapeHtml(activity.name);
  const opening = escapeHtml(activity.flow?.opening ?? "");

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<title>${name} · 报名</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Segoe UI",sans-serif;
    background:#0f1115;color:#e8eaed;min-height:100vh;display:flex;align-items:center;
    justify-content:center;padding:24px}
  .card{width:100%;max-width:400px;text-align:center}
  h1{font-size:20px;font-weight:600;margin-bottom:8px}
  .sub{color:#9aa0a6;font-size:14px;line-height:1.6;margin-bottom:28px}
  .box{background:#171a1f;border:1px solid #272b33;border-radius:14px;padding:24px;margin-bottom:16px}
  .qr{background:#fff;padding:10px;border-radius:10px;display:inline-block;line-height:0}
  .qr img{width:220px;height:220px;display:block}
  .btn{display:block;width:100%;padding:15px;border-radius:12px;background:#07c160;color:#fff;
    font-size:16px;font-weight:600;text-decoration:none;border:none;cursor:pointer}
  .btn:active{opacity:.85}
  .btn[disabled]{background:#2a2e35;color:#6b7280;cursor:default}
  .hint{color:#9aa0a6;font-size:13px;margin-top:14px;line-height:1.6}
  .state{font-size:15px;line-height:1.7}
  .ok{color:#07c160;font-size:44px;margin-bottom:10px}
  .err{color:#f87171}
  .spin{width:26px;height:26px;border:3px solid #2a2e35;border-top-color:#07c160;
    border-radius:50%;animation:r .8s linear infinite;margin:0 auto 14px}
  @keyframes r{to{transform:rotate(360deg)}}
</style>
</head>
<body>
<div class="card">
  <h1>${name}</h1>
  <p class="sub">${opening || "点击下方按钮，在微信里和小助手聊两句完成报名"}</p>
  <div class="box" id="box">
    <div class="spin"></div>
    <div class="state">正在准备…</div>
  </div>
  <p class="hint" id="hint"></p>
</div>

<script>
// 微信内置浏览器里可以直接点链接拉起 ClawBot，比扫码顺畅得多；
// 其他浏览器（桌面端）才需要显示二维码用手机扫。
var inWeChat = /MicroMessenger/i.test(navigator.userAgent);
var box = document.getElementById('box');
var hint = document.getElementById('hint');
var sessionId = null, timer = null, lastQr = null;

function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){
  return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];});}

function showError(msg, retry){
  clearInterval(timer);
  box.innerHTML = '<div class="state err">' + esc(msg) + '</div>';
  hint.innerHTML = retry ? '<button class="btn" style="margin-top:14px" onclick="start()">重新开始</button>' : '';
}

function renderQr(url){
  if (url === lastQr) return;      // 同一张码不重复渲染，避免闪烁
  lastQr = url;
  if (inWeChat){
    box.innerHTML =
      '<a class="btn" href="' + esc(url) + '">点击连接小助手</a>' +
      '<p class="hint">点击后微信会打开小助手，回到聊天窗口即可开始</p>';
    hint.textContent = '若长时间无反应，请点上方按钮重试';
  } else {
    box.innerHTML = '<div class="qr"><img id="qrimg" alt="二维码"></div>' +
      '<p class="hint">请用微信扫描二维码</p>';
    fetch('/api/qrcode?url=' + encodeURIComponent(url))
      .then(function(r){return r.text();})
      .then(function(d){var i=document.getElementById('qrimg'); if(i) i.src=d;});
    hint.textContent = '二维码约两分钟更新一次，过期会自动换新';
  }
}

function poll(){
  if (!sessionId) return;
  fetch('/api/session/' + sessionId).then(function(r){
    if (r.status === 404) throw new Error('会话已过期');
    return r.json();
  }).then(function(s){
    if (s.status === 'pending' && s.qrUrl) renderQr(s.qrUrl);
    else if (s.status === 'scanned'){
      box.innerHTML = '<div class="spin"></div><div class="state">已扫码，请在手机上确认…</div>';
      hint.textContent = '';
      lastQr = null;
    }
    else if (s.status === 'bound'){
      clearInterval(timer);
      box.innerHTML = '<div class="ok">✓</div><div class="state">连接成功！<br>请回到微信，和小助手聊两句完成报名</div>';
      hint.textContent = '小助手已经出现在你的微信联系人里';
    }
    else if (s.status === 'failed' || s.status === 'closed'){
      showError(s.error || '连接已结束', true);
    }
  }).catch(function(e){ showError(e.message || '网络异常', true); });
}

function start(){
  clearInterval(timer);
  lastQr = null;
  box.innerHTML = '<div class="spin"></div><div class="state">正在准备…</div>';
  hint.textContent = '';
  fetch('/api/session', {method:'POST'}).then(function(r){
    if (!r.ok) throw new Error('创建会话失败');
    return r.json();
  }).then(function(s){
    sessionId = s.id;
    if (s.qrUrl) renderQr(s.qrUrl);
    timer = setInterval(poll, 2000);
  }).catch(function(e){ showError(e.message || '暂时无法连接，请稍后重试', true); });
}

start();
</script>
</body>
</html>`;
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  );
}
