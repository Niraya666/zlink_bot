# zlink

微信扫码报名机器人：参与者扫码建立连接，机器人用多轮对话把报名信息聊出来，
组织者拿到的是一份有上下文的画像，而不是一张表单。

基于 iLink Bot 协议 + DeepSeek。换一场活动只写配置文件，不改代码。

## 快速开始

### 1. 环境要求

- Node.js >= 22.5（数据库用内置的 `node:sqlite`，无需原生编译）
- 一个 DeepSeek API Key（或任何 Anthropic Messages API 兼容端点）

只有 3 个纯 JS 依赖，`node_modules` 约 18M，没有任何需要编译的东西。

### 2. 安装

```bash
git clone git@github.com:Niraya666/zlink_bot.git
cd zlink_bot
npm install
cp .env.example .env
```

编辑 `.env` 填入 API Key。**`.env` 不在 git 里，也不要粘贴进任何聊天窗口**——
传到别的机器用 `scp`。

### 3. 自检

```bash
node scripts/preflight.mjs <活动slug>
```

会检查 Node 版本、依赖、`.env`、`data/` 可写性、活动 pack 合法性、端口占用、
cloudflared、微信连通性。缺什么直接给出可粘贴的修复命令。

### 4. 运行

⚠️ **所有命令都要带 `--env-file=.env`**——项目不自动加载 `.env`，
漏了会在第一次调用 LLM 时才报错。

```bash
# 多会话 —— 对外报名用，每个参与者打开页面各自扫码
node --env-file=.env cli.js serve <slug>

# 单绑定 —— 本地自测用，你自己扫一次码
node --env-file=.env cli.js run <slug>
```

`serve` 起两个服务：

| 端口 | 用途 | 是否对外 |
|---|---|---|
| `:3001` | 参与者页面 | ✅ 隧道只指向它 |
| `:3000` | 运营者控制台 | ❌ **无鉴权、含报名者隐私，绝不能暴露** |

端口可在 `activity.json` 用 `join_port` / `web_port` 覆盖。

不需要 API Key 的命令可以省略 `--env-file`：

```bash
node cli.js list                    # 所有活动 + 报名统计
node cli.js export <slug> --csv     # 导出报名数据（省略 --csv 则为 JSON）
node cli.js relogin                 # 清除单绑定模式的登录态
node cli.js help
```

`npm link` 之后可以直接用 `zlink <命令>`。

## 活动 pack

对话行为全部由 `activities/<slug>/` 下的文件控制：

```
activities/example-roundtable/
├── activity.json   # 元信息与开关（名称、close_when_complete、收尾话术）
├── fields.json     # 字段 schema（key / label / type / required）
├── flow.md         # 引导策略：frontmatter（tone/strictness/opening）+ 正文 prompt
├── rubric.md       # （可选）选人标准，席位有限时用
└── recruitment.md  # （可选）招募文案，rubric 的溯源依据
```

仓库里带了三个样例包，可以直接抄：

| pack | 看什么 |
|---|---|
| `demo-day-2026` | 最小可用配置，三个文件就跑得起来 |
| `example-with-tools` | 两个逃生舱：自定义工具 ＋ 自定义结果页 |
| `example-roundtable` | 完整的一场筛选型活动：招募文案 → rubric → 引导策略如何层层对齐 |

- `fields.json` 同时驱动三处：必收字段判定、字段记录、控制台表格的列
- `close_when_complete: true` 时必收字段收齐即自动收尾
- **每收一条消息都会重新加载 pack，改配置无需重启**

配置覆盖不了的少数情况有两个逃生舱（见 `activities/example-with-tools/`）：

- `tools.js` — 自定义工具，供模型在对话中调用（查实时名额、发定制内容等）。
  协议 `{ name, description, input_schema, handler(input, ctx) }`，
  `ctx = { db, user, activity }`
- `views/summary.html` — 自定义结果页，存在即整页替换控制台；
  core 注入 `window.__ZLINK__ = { eventName, fields }`，`/api/*` 照常可用

## 用 skills 配活动

不用手写配置文件。在 Claude Code 里对话式完成——**每个 skill 都能单独用**，
不必走完整条链路。

| skill | 做什么 | 产出 |
|---|---|---|
| `new-activity` | 访谈式生成整个 pack | `activities/<slug>/` |
| `edit-activity` | 调字段、语气、开场白、收尾行为 | 改动已有 pack |
| `test-activity` | 上线前模拟一遍对话 | 只在对话里，不落盘 |
| `design-rubric` | 从招募文案派生选人标准，并反查字段够不够 | `activities/<slug>/rubric.md` |
| `select-participants` | 按 rubric 评议报名数据 | `data/review-<slug>.md` |

### 例：从零办一场活动

```
> /new-activity

你：办一场读书会，10 月 12 日下午，限 8 人。想知道大家读没读过这本书、
    以及想聊哪一章
Claude：（问 2–3 轮：语气偏轻松还是正式？收齐信息就自动收尾吗？开场白这样写行吗？）
        → 生成 activities/bookclub-2026-10/{activity.json,fields.json,flow.md}
```

```
> /test-activity bookclub-2026-10

Claude 扮演报名助手跟你走一遍完整对话，跑完回报：
  ✓ 4 个必收字段都收到了
  ⚠ 「想聊哪一章」问得太晚 —— close_when_complete 已触发，这一问没送出去
```

```
> /edit-activity bookclub-2026-10

你：把「想聊哪一章」提到登记信息之前问
```

```bash
node --env-file=.env cli.js serve bookclub-2026-10
```

### 例：报名人数超过席位

```
> /design-rubric bookclub-2026-10

你：（贴上招募文案）
Claude：从文案抽出 3 个维度，每个标注出处
          · 读过这本书        ←「读完再来，我们不做导读」
          · 带一个具体的疑问  ←「带着一个问题来」
          · ...
        ⚠ 「带一个疑问」只有可选字段 bring_question 撑着。
          升为必收？还是降低它在 rubric 里的权重？
        → 写入 activities/bookclub-2026-10/rubric.md
```

```
> /select-participants bookclub-2026-10

Claude：读 rubric.md ＋ cli.js export 的报名数据，输出
          · 入池 11 人 / 不入池 3 人，各附一句理由
          · 各维度覆盖情况与缺口告警
          · 2 套 8 人组合，各自的张力与塌陷风险
          · 每个落选者一句可反驳的理由
        → 写入 data/review-bookclub-2026-10.md
        名单由你定 —— skill 给依据，不给决定
```

`rubric.md` 只引用公开文案，可以随招募文案一起公开。评议记录含报名者个人信息
与直接评价，落在 gitignore 覆盖的 `data/` 下，不进仓库。

## 对外开放：隧道

参与者页面必须能从公网打开。两条路，**隧道本身都免费**，差别在 URL 稳不稳定。

实测微信内置浏览器**不要求域名备案**，`*.trycloudflare.com` 直接打开无警告页
（测试条件与局限见 [public-exposure-plan.md](docs/public-exposure-plan.md)）。

### A. Quick Tunnel —— 零成本，当天开跑

```bash
cloudflared tunnel --url http://localhost:3001
```

不需要 Cloudflare 账号、不需要域名、不需要进后台。命令跑起来就给你一个
`https://<随机词>.trycloudflare.com`。

代价有两条，都不小：

- **进程一重启 URL 就变**，已经发进群的链接当场作废。所以别给 cloudflared
  配自动重启，也别在招募中途重启它
- `*.trycloudflare.com` 是多人共用的公共域名，**被他人滥用会连累你的链接被拦**

适合：小范围测试、双绑定验证、活动当天临时开、报名窗口只有几小时。

### B. Named Tunnel + 自有域名 —— URL 永不变

需要一个托管在 Cloudflare 的域名（Registrar 约 $10/年，这是唯一的花费）。
在 Zero Trust → Networks → Tunnels 建隧道拿 token，Public Hostname 指向
`localhost:3001`。

适合：链接要发进几百人的群、报名窗口跨天、服务要能自动重启自愈。

⚠️ **只映射 3001。** 3000 是无鉴权的运营者控制台，会漏报名者隐私。

### 怎么选

先用 Quick Tunnel 把流程跑通（尤其是双绑定验证这步），确认要正式办活动
再去买域名换 Named Tunnel。**别为了跑通第一次测试先花钱。**

## 部署与运行一场真实活动

| 文档 | 场景 |
|---|---|
| [远程开跑清单](docs/remote-setup-openclaw.md) | **人不在机器前**，通过 OpenClaw 操作；分步标注谁做什么 |
| [部署到 Mac mini](docs/deploy-mac-mini.md) | launchd 自愈 + 固定域名；家宽 IP，微信风控更稳 |
| [部署到云主机](docs/deploy-cloud.md) | systemd + 隧道；能 SSH 随时修 |
| [活动当天运行手册](docs/runbook-live-test.md) | 开跑流程与排障 |

⚠️ 对外开放前**必须**先跑双绑定验证（需两个微信号）：

```bash
node scripts/probe-dual-binding.mjs --links-only
```

它回答的是「一台机器能不能同时服务多个参与者」。没验证就发链接进群，
出问题时已经来不及。

### 重新扫码 / 重新绑定（仅 `run` 单绑定模式）

`run` 模式的登录态持久化在 `~/.wechatbot/`，所以**第二次跑不会再显示二维码**
——这是正常行为，不是 bug。要换绑定或登录已失效时：

```bash
node cli.js relogin
node --env-file=.env cli.js run <slug>
```

> 会话中途失效时 SDK 会自动重登，但新二维码只打印在**终端**，不会推到网页控制台
> （SDK 已知限制）。控制台此时提示「登录已失效」。

`serve` 多会话模式不适用：每个参与者的会话独立存在 `data/sessions/<uuid>`，
停服即清空。

## 它怎么工作

**不存在一个「机器人微信号」让大家去加好友。**

iLink 是一对一的个人模型：每个参与者各自打开报名页面、扫自己那张二维码，
ClawBot 就出现在**他自己的微信联系人里**，然后开始对话。

```
参与者A ─扫码─> 绑定A ─┐
参与者B ─扫码─> 绑定B ─┼─> 同一个 zlink 进程 ─> LLM
参与者C ─扫码─> 绑定C ─┘                         │
                                             SQLite
```

由此带来两个后果：

- **需要一个能对外访问的页面**发给参与者。截图二维码发出去没用——单张码约
  120 秒过期
- **停服会销毁全部绑定**（`data/sessions/` 按设计清空），之后无法再用 bot
  联系参与者。通知结果要走群里

多绑定共存、消息不串台已实测，详见 [multi-binding-findings.md](docs/multi-binding-findings.md)。

## 项目结构

```
cli.js                     # 入口：serve / run / list / export / relogin
core/
├── activity.js            # 活动 pack 加载与校验
├── paths.js               # 项目路径（不依赖 cwd，CLI 可从任意目录调用）
├── run.js                 # 单绑定编排：数据库 + 控制台 + 机器人
├── serve.js               # 多会话编排 + 进程级崩溃兜底
├── channel/
│   ├── wechat.js          # iLink SDK 封装（消息收发）
│   ├── qr-login.js        # 自实现的 QR 登录流程（不走 SDK 的，见下）
│   ├── session-manager.js # 会话状态机 + 僵尸绑定回收
│   └── session.js         # 已保存登录态的检测与清除
├── engine/
│   ├── conversation.js    # 对话处理、按用户串行化、发送重试
│   ├── prompt.js          # system prompt 渲染
│   ├── tools.js           # 工具定义（按 pack 动态生成）
│   ├── custom-tools.js    # pack 内 tools.js 逃生舱的加载与校验
│   └── llm.js             # LLM API 封装（Anthropic 兼容模式）
├── store/
│   └── db.js              # SQLite（node:sqlite），按活动作用域化
└── dashboard/
    ├── server.js          # 运营者控制台 :3000
    └── join.js            # 参与者页面 :3001
activities/<slug>/         # 活动 pack（配置的唯一事实来源）
scripts/
├── preflight.mjs                 # 环境自检
├── probe-dual-binding.mjs        # 双绑定验证（对外前必跑）
├── probe-concurrent-sessions.mjs # 并发绑定数压测
└── probe-storage-isolation.mjs   # 确认多实例凭证互不覆盖
data/                      # 运行时数据，全部 gitignore
├── bot.sqlite
└── sessions/<uuid>/       # 每个参与者的绑定凭证，停服即清
```

`core/` 内不含任何活动语义；活动特定的一切都在 `activities/<slug>/`。

> QR 登录为什么自己实现：SDK 的 `pollQrStatus` 用 15 秒超时去调一个会挂起
> 约 45 秒的长轮询接口，任何超过 15 秒的扫码都会失败。`core/channel/qr-login.js`
> 用裸 `fetch` 重写了这段，不碰 SDK 内部。

## 对话流程

1. 用户发消息 → iLink 长轮询收到
2. 查 SQLite 取历史 + 已采集画像
3. 拼 system prompt（问题清单 + 已采集字段 + 缺失字段）
4. 调 LLM（带 tool use）
5. 模型决定记录哪些字段（`save_field`）或结束对话（`mark_complete`）；
   `save_field` 只接受 `fields.json` 里的 key，布尔字段归一化为 true/false，
   不合法的调用会被拒绝并把可用字段清单回传给模型自纠
6. 回复用户，保存消息到数据库

同一用户的消息按到达顺序**串行处理**，回复发送失败会重试 3 次
（SDK 不重试 ECONNRESET）。

## 技术栈

| 层 | 选型 |
|---|---|
| 运行时 | Node.js ≥ 22.5 |
| 微信接入 | `@wechatbot/wechatbot` SDK 2.2 + 自实现 QR 登录 |
| LLM | DeepSeek（Anthropic Messages API 兼容端点） |
| 数据库 | SQLite（Node 内置 `node:sqlite`，无需原生编译） |
| 公网暴露 | Cloudflare Tunnel（出站连接，不开入站端口） |

## License

[MIT](LICENSE)
