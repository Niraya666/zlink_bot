# 部署方案 A：Mac mini + 自愈 + 固定域名

> 适用：你人在外面碰不到 Mac mini，但希望它稳定跑几天的报名窗口
> 目标：进程崩了自动拉起、机器不睡、URL 永不变
> 前置：Mac mini 已装 Node ≥22.5、能通过 OpenClaw 执行命令；一个自有域名托管在 Cloudflare

**这份方案的最大优势：家宽 IP。** 从境外数据中心 IP 批量绑定微信号存在风控未知数
（见 `docs/public-exposure-plan.md` §5），而家宽 IP 与你此前测试时的环境完全一致。

## 0. 需要你亲自做的两件事（其余都能远程）

1. **在 Cloudflare 后台建隧道拿 token** —— 见 §2，因为 `cloudflared tunnel login`
   要开浏览器授权，远程不方便。用后台生成的 token 可以完全跳过浏览器。
2. **确认 Mac mini 处于登录状态** —— 下面用的是 LaunchAgent，它在用户登录后才启动。
   如果机器可能重启且没开自动登录，服务不会自己回来（见 §6 的取舍说明）。

## 1. 把环境准备好

### 1.1 全新机器：先装工具、再 clone

如果 Mac mini 上还没有这个项目，从这里开始。已经有了就跳到 §1.2。

```bash
# Homebrew（已有会提示 already installed，无害）
which brew || /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# Node ≥ 22.5 —— node:sqlite 依赖它，版本不够会直接跑不起来
node -v 2>/dev/null || brew install node

# 拉代码（路径可自定，后面 plist 会自动读当前路径）
mkdir -p ~/project/zlink && cd ~/project/zlink
git clone git@github.com:Niraya666/zlink_bot.git
cd zlink_bot
npm install
```

> SSH 拉不动就换 HTTPS：
> `git clone https://github.com/Niraya666/zlink_bot.git`

### 1.2 已有项目：更新到最新

```bash
cd ~/project/zlink/zlink_bot     # 按实际路径调整
git pull
npm install                      # 依赖可能有变动
```

### 1.3 传 `.env`（唯一无法自动化的一步）

`.env` 不在 git 里，**必须从你的笔记本传过去**。这一步 Mac mini 上的
OpenClaw 自己做不了，也**不要**把 key 贴进任何聊天窗口：

```bash
# 在你的笔记本上执行
scp .env <mac-mini地址>:~/project/zlink/zlink_bot/.env
```

### 1.4 一条命令自检

**不用照着文档逐条猜哪里没配好**，跑这个，缺什么它会直接说：

```bash
node scripts/preflight.mjs zchat-23
```

它会检查 Node 版本、依赖、`.env`（只看有没有，不打印值）、`data/` 可写性、
活动 pack 是否合法、端口是否被占、cloudflared 是否安装、以及到微信服务器的连通性，
并对每个问题给出修复命令。

**全绿再往下走。**

## 2. 建 named tunnel（拿到永不变的 URL）

**在 Cloudflare 后台操作**（Zero Trust → Networks → Tunnels）：

1. Create a tunnel → 选 Cloudflared → 起个名字（如 `zlink`）
2. 复制它给出的 **token**（一长串）
3. 在 Public Hostname 里加一条：
   - Subdomain：`join`（或你喜欢的）
   - Domain：你的域名
   - Service：`HTTP` → `localhost:3001`

这样 `https://join.你的域名` 就永久指向参与者页面。**进程重启、机器重启，URL 都不变**——
这正是 quick tunnel 做不到的，也是能把链接发进 300 人群的前提。

⚠️ **只映射 3001**。3000 是运营者控制台，无鉴权、会漏出报名数据，**绝不能对外**。

在 Mac mini 上装成服务：

```bash
brew install cloudflared
sudo cloudflared service install <粘贴你的 token>
```

这一步需要 sudo 密码。如果远程给不了，改用后台方式（不开机自启，但能跑）：

```bash
nohup cloudflared tunnel run --token <TOKEN> > /tmp/cloudflared.log 2>&1 &
```

验证：

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://join.你的域名/
```

## 3. 让机器不睡（不需要 sudo）

`pmset` 要 sudo，远程可能给不了。改用 `caffeinate` 把防睡眠**包在服务里**——
下一步的 launchd 配置已经这么写了，不用额外操作。

```
caffeinate -dimsu node cli.js serve zchat-23
         │││││
         ││││└ 阻止系统空闲睡眠
         │││└─ 阻止磁盘睡眠
         ││└── 阻止显示器睡眠
         │└─── 阻止空闲睡眠
         └──── 声明为用户活动
```

## 4. 配 launchd 自愈

**在项目根目录执行**这段——它会自动填入当前路径和 node 的真实位置，
避免手工替换占位符出错（Apple Silicon 的 node 在 `/opt/homebrew/bin/node`，
Intel 在 `/usr/local/bin/node`，写错了服务起不来且报错很隐晦）：

```bash
ACTIVITY=zchat-23          # 改成你要跑的活动
PROJ="$(pwd)"
NODE="$(which node)"

mkdir -p ~/Library/LaunchAgents
cat > ~/Library/LaunchAgents/com.zlink.serve.plist <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.zlink.serve</string>

  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/caffeinate</string>
    <string>-dimsu</string>
    <string>${NODE}</string>
    <string>--env-file=.env</string>
    <string>cli.js</string>
    <string>serve</string>
    <string>${ACTIVITY}</string>
  </array>

  <key>WorkingDirectory</key>
  <string>${PROJ}</string>

  <!-- 崩了自动拉起，这是整个方案的核心 -->
  <key>KeepAlive</key>
  <true/>
  <key>RunAtLoad</key>
  <true/>

  <!-- 别疯狂重启：至少间隔 10 秒 -->
  <key>ThrottleInterval</key>
  <integer>10</integer>

  <key>StandardOutPath</key>
  <string>/tmp/zlink-serve.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/zlink-serve.log</string>
</dict>
</plist>
PLIST

echo "已生成，核对一下路径："
grep -E "opt/homebrew|usr/local|WorkingDirectory" -A1 ~/Library/LaunchAgents/com.zlink.serve.plist
```

> 注意这里的 heredoc 用的是 `PLIST` 而非 `'PLIST'`（不加引号），
> 变量才会被展开。

加载：

```bash
launchctl unload ~/Library/LaunchAgents/com.zlink.serve.plist 2>/dev/null
launchctl load  ~/Library/LaunchAgents/com.zlink.serve.plist
sleep 5
tail -20 /tmp/zlink-serve.log
```

看到「参与者页面已启动」即成功。

验证自愈（**建议真跑一次**，别假设它有效）：

```bash
pkill -f "cli.js serve"
sleep 15
tail -5 /tmp/zlink-serve.log     # 应看到重新启动的日志
```

## 5. 上线前的最后一道验证

**不要跳过。** 用两个微信号跑一遍：

```bash
launchctl unload ~/Library/LaunchAgents/com.zlink.serve.plist
node scripts/probe-dual-binding.mjs
# 两个号各自扫码 → 确认 Q1/Q2 通过 → Ctrl-C
launchctl load ~/Library/LaunchAgents/com.zlink.serve.plist
```

然后用手机流量（**关 WiFi**）在微信里打开 `https://join.你的域名`，
确认能出码、能扫、能对话。

## 6. 这个方案的已知短板

| 故障 | 能否自愈 |
|---|---|
| 进程崩溃 | ✅ launchd 拉起 |
| 网络抖动 | ✅ 代码内已重试（见 `conversation.js`） |
| cloudflared 挂 | ✅ 装成 service 的话可以；后台跑的话不行 |
| 机器睡眠 | ✅ caffeinate |
| **系统重启 / 断电** | ❌ **LaunchAgent 需要用户登录后才启动** |
| **断网** | ❌ 只能等恢复 |

想覆盖重启，两条路：开启自动登录（有安全代价），或改用
`/Library/LaunchDaemons`（开机即启，但要 sudo，且要处理路径与权限）。
**报名窗口只有几天的话，我倾向不折腾，接受这个风险。**

## 7. 远程巡检（通过 OpenClaw）

```bash
# 服务在不在
launchctl list | grep zlink

# 最近日志（含每轮耗时、重试、未送达告警）
tail -30 /tmp/zlink-serve.log

# 当前报名情况
node cli.js list

# 导出数据
node cli.js export zchat-23 --csv > ~/signups.csv
```

日志里这几个信号要留意：

- `发送 X.Xs/重试N次` —— 网络在抖，但接住了，正常
- `未送达🔴` —— 有回复没发出去，需要人工跟进
- `⚠ 未处理的 Promise 异常` —— 兜底捕获，服务还活着，但值得看堆栈

## 8. 收尾

```bash
launchctl unload ~/Library/LaunchAgents/com.zlink.serve.plist
rm ~/Library/LaunchAgents/com.zlink.serve.plist
sudo cloudflared service uninstall   # 或 pkill -f cloudflared
```

数据在 `data/bot.sqlite`，记得先导出再清理。
