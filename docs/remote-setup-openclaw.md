# 远程开跑清单（通过 OpenClaw 操作 Mac mini）

> 场景：你人不在 Mac mini 前，只能让它上面的 OpenClaw 执行命令
> 每一步都标注了**谁来做**——有三件事 OpenClaw 做不了，必须你亲自来

## 谁做什么

| 只能你做 | 原因 |
|---|---|
| 传 `.env` | 不在 git 里，且不该经过任何聊天窗口 |
| 拿 Cloudflare 隧道 token | 要登录后台，需要浏览器 |
| 用两个微信号扫码 | 需要手机 |

其余全部可以交给 OpenClaw。

---

## 第 1 步：环境就绪 · OpenClaw

把下面整段发给 OpenClaw：

```bash
# 没有项目就 clone，有就更新
if [ -d ~/zlink_bot ]; then
  cd ~/zlink_bot && git pull
else
  cd ~ && git clone git@github.com:Niraya666/zlink_bot.git && cd zlink_bot
fi
npm install
node -v
pwd
```

**要 OpenClaw 回报**：`node -v`（必须 ≥ v22.5）和 `pwd`（后面要用的项目路径）。

> SSH 拉不动就换：`git clone https://github.com/Niraya666/zlink_bot.git`
> Node 版本不够：`brew install node`

---

## 第 2 步：传 `.env` · 你亲自做

在**这台笔记本**上执行（`<路径>` 用第 1 步 OpenClaw 回报的 `pwd`）：

```bash
scp .env <mac-mini地址>:<路径>/.env
```

传完让 OpenClaw 收紧权限：

```bash
chmod 600 ~/zlink_bot/.env
```

---

## 第 3 步：自检 · OpenClaw

```bash
cd ~/zlink_bot && node scripts/preflight.mjs zchat-23
```

**要 OpenClaw 把完整输出发回来。** 全绿才继续；有 ❌ 它会直接给出修复命令，
照做后重跑。

---

## 第 4 步：双绑定验证 · 两边配合

**这一步不能跳过。** 它回答的是「一台机器能不能同时服务多个参与者」，
没验证就发链接进群，出问题时已经来不及。

让 OpenClaw 执行（注意 `--links-only`，否则终端二维码转述过来是乱码）：

```bash
cd ~/zlink_bot && node scripts/probe-dual-binding.mjs --links-only
```

接下来是一段交互，**让 OpenClaw 保持这个进程不要退出**：

1. OpenClaw 会看到 `【绑定 A 的链接】https://liteapp.weixin.qq.com/...`
   —— 让它把这行发给你
2. 你把链接发到**第一个微信号**上，点开完成绑定
3. 绑定成功后会出现 `【绑定 B 的链接】...` —— 同样发给你
4. 用**第二个微信号**点开第二个链接

   ⚠️ **这时盯紧**：如果 A 出现 `🔴 session:expired`，说明服务端只认最后
   一个绑定，多人同时报名不成立 —— 立刻停下告诉我
5. 两个号各发一条消息，确认各自收到带 `[A]` / `[B]` 标签的回复，**不串台**
6. 让 OpenClaw 按 `Ctrl-C`（或 `pkill -INT -f probe-dual-binding`），
   把最后的「观测汇总」发给你

**通过的标志**：汇总里 Q1 和 Q2 都是 ✅。

---

## 第 5 步：隧道 · 你拿 token，OpenClaw 装

### 5.1 你在 Cloudflare 后台操作

Zero Trust → Networks → Tunnels：

1. Create a tunnel → Cloudflared → 命名（如 `zlink`）
2. **复制 token**（一长串）
3. Public Hostname 加一条：
   - Subdomain `join` · Domain 你的域名
   - Service：`HTTP` → `localhost:3001`

⚠️ **只映射 3001**。3000 是运营者控制台，无鉴权、会漏报名数据，**绝不能对外**。

### 5.2 OpenClaw 安装

```bash
which cloudflared || brew install cloudflared
sudo cloudflared service install <把 token 粘在这里>
```

需要 sudo 密码。给不了的话用后台方式（不开机自启，但能跑）：

```bash
cd ~/zlink_bot
nohup cloudflared tunnel run --token <token> > /tmp/cloudflared.log 2>&1 &
sleep 5 && tail -5 /tmp/cloudflared.log
```

### 5.3 验证

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://join.你的域名/
```

服务还没起，此时返回 502 是正常的（说明隧道通了但后端没起）。

---

## 第 6 步：配自愈并启动 · OpenClaw

```bash
cd ~/zlink_bot
ACTIVITY=zchat-23
PROJ="$(pwd)"
NODE="$(which node)"

mkdir -p ~/Library/LaunchAgents
cat > ~/Library/LaunchAgents/com.zlink.serve.plist <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.zlink.serve</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/caffeinate</string><string>-dimsu</string>
    <string>${NODE}</string><string>--env-file=.env</string>
    <string>cli.js</string><string>serve</string><string>${ACTIVITY}</string>
  </array>
  <key>WorkingDirectory</key><string>${PROJ}</string>
  <key>KeepAlive</key><true/>
  <key>RunAtLoad</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>/tmp/zlink-serve.log</string>
  <key>StandardErrorPath</key><string>/tmp/zlink-serve.log</string>
</dict>
</plist>
PLIST

launchctl unload ~/Library/LaunchAgents/com.zlink.serve.plist 2>/dev/null
launchctl load ~/Library/LaunchAgents/com.zlink.serve.plist
sleep 6
tail -15 /tmp/zlink-serve.log
```

**要 OpenClaw 回报**日志里有没有「参与者页面已启动」。

### 验证自愈（真跑一次，别假设）

```bash
pkill -f "cli.js serve"; sleep 15
tail -5 /tmp/zlink-serve.log        # 应看到重新启动
launchctl list | grep zlink
```

---

## 第 7 步：端到端确认 · 你亲自做

用**手机流量**（关掉 WiFi，确保走公网）在微信里打开：

```
https://join.你的域名
```

确认：能出码 → 能扫 → 能对话 → 收到收尾话术。

这一步过了才能把链接发进群。

---

## 日常巡检 · OpenClaw

```bash
launchctl list | grep zlink                      # 服务在不在
tail -30 /tmp/zlink-serve.log                    # 最近日志
cd ~/zlink_bot && node cli.js list               # 报名统计
cd ~/zlink_bot && node cli.js export zchat-23 --csv > ~/signups.csv
```

日志里要留意的信号：

| 信号 | 含义 |
|---|---|
| `发送 X.Xs/重试N次` | 网络在抖但接住了，正常 |
| `未送达🔴` | 有回复没发出去，需人工跟进 |
| `⚠ 未处理的 Promise 异常` | 兜底捕获，服务还活着，值得看堆栈 |
| `⚠ 偏慢` | 单轮超 10 秒，看是 LLM 还是发送慢 |

---

## 收尾

```bash
cd ~/zlink_bot
node cli.js export zchat-23 --csv > ~/signups.csv     # 先导出！
node cli.js export zchat-23 > ~/signups.json
launchctl unload ~/Library/LaunchAgents/com.zlink.serve.plist
pkill -f cloudflared
```

⚠️ 停服会销毁所有会话绑定（`data/sessions` 按设计清空），
**之后就无法再用 bot 联系参与者**——通知入选结果要走群里。
报名数据在 `data/bot.sqlite`，不受影响。
