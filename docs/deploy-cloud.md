# 部署方案 B：境外云主机

> 适用：需要「一直在线」且「出事能 SSH 进去修」两者兼得
> 前置：一个自有域名托管在 Cloudflare
>
> ⚠️ **先读 §0 的风控提示再决定用不用这个方案。**

## 0. 一个必须先验证的未知数

**从境外数据中心 IP 批量绑定微信号，可能被风控当成异常。**

家宽 IP 和新加坡机房 IP 在微信眼里不是一回事。这纯属推测——但代价很高：
真出问题是在你已经把链接发进 300 人群之后。

**所以 §6 的双绑定验证不是可选步骤。** 机器开好、代码跑起来之后，
第一件事就是用两个微信号在云上实测绑定，通过了再 announce。

如果绑定失败或异常，退回方案 A（`docs/deploy-mac-mini.md`），
家宽 IP 在这件事上天然更安全。

## 1. 选机器

跑这个负载对配置要求极低（15–20 条长轮询 + 一个 Node 进程），
**1 核 1G 足够**。选型的关键不是性能，是地区和你的账号便利性。

| 服务商 | 地区 | 备注 |
|---|---|---|
| 腾讯云 / 阿里云**香港**轻量 | 香港 | 国内访问最快；**香港不需要备案**；需国内实名账号 |
| Vultr / DigitalOcean / Linode | 新加坡、东京 | 国际支付，开通快 |
| Hetzner | 欧洲 / 美国（**无亚洲**） | 最便宜，但离国内远 |

> 价格和免费额度变动频繁，请自行核实。**避开会空闲休眠的 PaaS 免费档**——
> 长轮询在服务端挂起、不产生入站请求，会被判定为空闲而休眠，那等于所有会话断连。

系统选 **Ubuntu 24.04 LTS** 或更新。

## 2. 装 Node ≥ 22.5

发行版自带的 Node 通常太老（`node:sqlite` 需要 22.5+）。用 NodeSource：

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs git
node -v      # 必须 ≥ v22.5
```

## 3. 拉代码

```bash
git clone git@github.com:Niraya666/zlink_bot.git
cd zlink_bot
npm install
```

依赖是三个纯 JS 包、无原生编译，所以这一步不会有意外
（这是当初把 `better-sqlite3` 换成内置 `node:sqlite` 的回报）。

```bash
node cli.js list     # 应看到 zchat-23
```

## 4. 传 `.env`

`.env` 不在 git 里。**用 scp，不要把 key 贴进任何聊天窗口或命令历史**：

```bash
# 在你的笔记本上执行
scp .env user@<服务器IP>:~/zlink_bot/.env
```

```bash
# 服务器上验证（只看有没有，不打印值）
chmod 600 .env
grep -c DEEPSEEK_API_KEY .env
```

## 5. 隧道 + 固定域名

**不要开 443 入站端口。** 用隧道，出站连接，攻击面最小，也不用配 TLS 证书。

在 Cloudflare 后台（Zero Trust → Networks → Tunnels）建隧道拿 token，
Public Hostname 配 `join.你的域名` → `HTTP` → `localhost:3001`。

⚠️ **只映射 3001**。3000 是控制台，无鉴权、会漏报名数据，**绝不能对外**。

```bash
# 安装 cloudflared（按官方当前文档为准）
sudo cloudflared service install <粘贴 token>
systemctl status cloudflared
```

顺手关掉所有入站（隧道不需要）：

```bash
sudo ufw default deny incoming
sudo ufw allow OpenSSH
sudo ufw enable
```

## 6. ⚠️ 上线前必做：双绑定验证

**这一步是 §0 那个未知数的答案，不能跳过。**

```bash
cd ~/zlink_bot
node scripts/probe-dual-binding.mjs
```

两个微信号分别扫终端里的二维码，观察：

- **Q1** 两个绑定能否共存（B 扫码后 A 会不会冒 `session:expired`）
- **Q2** 消息路由是否串台

任一失败 → **不要继续**，退回方案 A。

## 7. 配 systemd 自愈

```bash
sudo tee /etc/systemd/system/zlink.service > /dev/null <<'UNIT'
[Unit]
Description=zlink signup bot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=你的用户名
WorkingDirectory=/home/你的用户名/zlink_bot
ExecStart=/usr/bin/node --env-file=.env cli.js serve zchat-23

# 崩了自动拉起
Restart=always
RestartSec=10

StandardOutput=append:/var/log/zlink.log
StandardError=append:/var/log/zlink.log

[Install]
WantedBy=multi-user.target
UNIT

sudo touch /var/log/zlink.log && sudo chown 你的用户名 /var/log/zlink.log
sudo systemctl daemon-reload
sudo systemctl enable --now zlink
sudo systemctl status zlink
```

验证自愈（**真跑一次**，别假设）：

```bash
sudo pkill -f "cli.js serve"
sleep 15
sudo systemctl status zlink      # 应显示已重新拉起
```

## 8. 端到端验证

用手机流量（**关 WiFi**）在微信里打开 `https://join.你的域名`：

- 能出码
- 能扫、能建立绑定
- 能正常对话

## 9. 日常巡检

```bash
# 服务状态
systemctl status zlink

# 日志（含每轮耗时、重试、未送达告警）
tail -30 /var/log/zlink.log

# 报名情况
cd ~/zlink_bot && node cli.js list
```

要留意的信号：

- `发送 X.Xs/重试N次` —— 网络在抖但接住了，正常
- `未送达🔴` —— 有回复没发出去，需人工跟进
- `⚠ 未处理的 Promise 异常` —— 兜底捕获，服务还活着，但值得看堆栈

## 10. 数据与收尾

**数据在服务器上，别忘了导出再销毁机器：**

```bash
cd ~/zlink_bot
node cli.js export zchat-23 --csv > signups.csv
node cli.js export zchat-23 > signups.json
```

```bash
# 在笔记本上拉回来
scp user@<服务器IP>:~/zlink_bot/signups.* .
scp user@<服务器IP>:~/zlink_bot/data/bot.sqlite ./bot-backup.sqlite
```

停服：

```bash
sudo systemctl disable --now zlink
sudo cloudflared service uninstall
```

## 11. 与方案 A 的取舍

| | 云主机（本方案） | Mac mini（方案 A） |
|---|---|---|
| **微信风控** | ⚠️ 数据中心 IP，未知 | ✅ 家宽 IP，与测试环境一致 |
| 一直在线 | ✅ | ⚠️ 怕断电断网 |
| 出事能修 | ✅ SSH | ⚠️ 只能靠 OpenClaw |
| 重启后自恢复 | ✅ systemd enable | ❌ LaunchAgent 需登录 |
| 迁移成本 | 小（纯 JS，18M） | 零 |
| 成本 | 几美元/月 | 0 |

**决定性的分歧在第一行。** 如果 §6 验证通过，云主机整体更稳；
如果验证失败或你不想赌，方案 A 的失败模式更可控。
