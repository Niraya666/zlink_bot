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
  html{background:#fafaf7}
  body{font-family:Inter,"Avenir Next",-apple-system,BlinkMacSystemFont,"PingFang SC",
    "Noto Sans SC","Segoe UI",sans-serif;background:#fafaf7;color:#141412;min-height:100vh;
    -webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
  .card{width:100%;max-width:432px;margin:0 auto;padding:40px 22px 80px;text-align:left}
  h1{font-size:29px;font-weight:800;line-height:1.15;letter-spacing:-.035em;margin-bottom:10px}
  .sub{color:#8a8a82;font-size:14px;line-height:1.62;margin-bottom:40px;max-width:36em}
  .box{min-height:284px;display:flex;flex-direction:column;align-items:center;
    justify-content:center;text-align:center;margin-bottom:18px}
  .qr{background:#fff;padding:13px;border:1px solid #e7e6e0;border-radius:18px;
    display:inline-block;line-height:0}
  .qr img{width:220px;height:220px;display:block;border-radius:7px}
  .btn{display:block;width:100%;padding:14px 16px;border-radius:14px;background:#fdfdfb;
    color:#141412;font-size:15px;font-weight:650;line-height:1.35;text-decoration:none;
    border:1px solid #deddd6;cursor:pointer;transition:background .16s ease,border-color .16s ease,
    transform .16s ease}
  .btn:hover{background:#f5f4ef;border-color:#cfcec6}
  .btn:active{transform:translateY(1px)}
  .btn:focus-visible{outline:2px solid #141412;outline-offset:3px}
  .btn[disabled]{background:#f3f2ed;color:#aaa9a2;border-color:#e7e6e0;cursor:default}
  .hint{color:#8a8a82;font-size:13px;margin-top:14px;line-height:1.6;text-align:center}
  .state{font-size:15px;line-height:1.7;color:#4f4f49}
  .ok{width:44px;height:44px;border:1px solid #deddd6;border-radius:50%;display:flex;
    align-items:center;justify-content:center;color:#141412;font-size:24px;margin:0 auto 14px}
  .err{color:#a24f46}
  .spin{width:25px;height:25px;border:2px solid #e2e1da;border-top-color:#141412;
    border-radius:50%;animation:r .8s linear infinite;margin:0 auto 16px}
  @keyframes r{to{transform:rotate(360deg)}}
  @media (max-width:480px){
    .card{padding:32px 20px 64px}
    h1{font-size:27px}
    .sub{margin-bottom:30px}
    .box{min-height:270px}
    .qr img{width:min(220px,62vw);height:min(220px,62vw)}
  }
  @media (prefers-reduced-motion:reduce){
    .btn{transition:none}
    .spin{animation-duration:1.2s}
  }
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
