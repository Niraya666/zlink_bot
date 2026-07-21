# iLink Bot 原型

基于 iLink Bot API + DeepSeek 的微信机器人，实现多轮对话完成用户画像采集。

## 快速开始

### 1. 环境要求

- Node.js >= 22.5（数据库使用内置的 `node:sqlite`，无需原生编译）
- 一个微信机器人账号（通过 iLink 协议接入）

### 2. 安装

```bash
git clone git@github.com:Niraya666/zlink_bot.git
cd zlink_bot
npm install
```

### 3. 配置

编辑 `.env` 文件，填入 DeepSeek API Key：

```bash
cp .env.example .env   # 如果没有 .env 的话
```

```env
DEEPSEEK_API_KEY=sk-your-key-here
DEEPSEEK_BASE_URL=https://api.deepseek.com/anthropic
DEEPSEEK_MODEL=deepseek-chat
```

对话行为由**活动 pack** 控制——`activities/<slug>/` 下的三个文件：

```
activities/demo-day-2026/
├── activity.json   # 元信息与开关（名称、close_when_complete、收尾话术）
├── fields.json     # 字段 schema（key / label / type / required）
└── flow.md         # 引导策略：frontmatter（tone/strictness/opening）+ 正文 prompt
```

- `fields.json` 同时驱动三处：必收字段判定、字段记录、控制台表格的列
- `close_when_complete` 设为 `true` 时，必收字段收齐即自动收尾
- 机器人每收一条消息都会重新加载 pack，**改配置无需重启**

创建和修改活动不用手写文件——在 Claude Code 里用 `new-activity` / `edit-activity`
skill 对话式完成，`test-activity` 可在上线前模拟一遍对话。

配置覆盖不了的少数情况，pack 还有两个可选逃生舱（见 `activities/example-with-tools/`）：

- `tools.js` — 自定义工具，供模型在对话中调用（查实时名额、发定制内容等）。
  协议 `{ name, description, input_schema, handler(input, ctx) }`，`ctx = { db, user, activity }`
- `views/summary.html` — 自定义结果页，存在即整页替换控制台；core 注入
  `window.__ZLINK__ = { eventName, fields }`，`/api/*` 端点照常可用

### 4. 运行

```bash
npm start                       # activities/ 下只有一个活动时
node cli.js run demo-day-2026   # 有多个活动时指定
```

其他命令：

```bash
node cli.js list                          # 列出所有活动及报名统计
node cli.js export demo-day-2026 --csv    # 导出报名数据（省略 --csv 则为 JSON）
node cli.js relogin                       # 清除登录态，下次启动重新扫码
node cli.js help
```

`npm link` 之后可直接用 `zlink run` / `zlink list` / `zlink export` / `zlink relogin`。
同时跑多场活动就开多个进程，在各自的 `activity.json` 里设 `web_port` 避免端口冲突。

首次运行会打印二维码链接，用微信扫码绑定机器人。之后任何人给这个微信号发消息，都会进入对话流程。

### 重新扫码 / 重新绑定

登录态会持久化到 `~/.wechatbot/`（SDK 的 `storage: "file"` 特性），所以**第二次
`npm start` 会直接复用已保存的登录、不再显示二维码**——这是正常行为，不是 bug。

以下情况需要重新扫码：登录已失效、想绑定另一个微信账号。运行：

```bash
npm run relogin   # 清除 ~/.wechatbot/ 下的登录态
npm start         # 重新显示二维码
```

> 注意：会话中途失效时，SDK 会自动尝试重新登录，但新二维码只会打印在**终端**
> （不会推送到网页控制台，这是 SDK 的已知限制）。控制台此时会提示「登录已失效」，
> 按提示看终端扫码，或 `npm run relogin` 后重启即可。

## 项目结构

```
cli.js                     # 入口：run / list / export / relogin
core/
├── activity.js            # 活动 pack 加载与校验
├── paths.js               # 项目路径（不依赖 cwd，CLI 可从任意目录调用）
├── run.js                 # 编排：数据库 + 控制台 + 机器人
├── channel/
│   ├── wechat.js          # iLink SDK 封装（QR 登录、消息收发）
│   └── session.js         # 已保存登录态的检测与清除
├── engine/
│   ├── conversation.js    # 对话处理 + 工具调用校验
│   ├── prompt.js          # system prompt 渲染
│   ├── tools.js           # 工具定义（按 pack 动态生成）
│   └── llm.js             # DeepSeek API 封装（Anthropic 兼容模式）
├── store/
│   └── db.js              # SQLite（node:sqlite），按活动作用域化
└── dashboard/
    └── server.js          # 网页控制台（状态 / 二维码 / 报名列表）
activities/
└── <slug>/                # 活动 pack
    ├── activity.json      # 元信息与开关（含可选 web_port）
    ├── fields.json        # 字段 schema
    ├── flow.md            # 引导策略
    ├── tools.js           # （可选）自定义工具
    └── views/summary.html # （可选）自定义结果页
data/
└── bot.sqlite             # 运行时自动创建
```

## 对话流程

1. 用户发消息 → iLink 长轮询收到
2. 查 SQLite 获取用户历史 + 已采集画像
3. 拼 system prompt（问题清单 + 已采集字段 + 缺失字段）
4. 调 DeepSeek API（带 tool use）
5. 模型决定记录哪些字段 (`save_field`) 或结束对话 (`mark_complete`)；
   `save_field` 只接受 `fields.json` 里的 key，布尔字段会归一化为 true/false，
   不合法的调用会被拒绝并把可用字段清单回传给模型自纠
6. 回复用户，保存消息到数据库

## 技术栈

| 层 | 选型 |
|---|---|
| 运行时 | Node.js ≥ 22.5 |
| 微信接入 | @wechatbot/wechatbot SDK |
| LLM | DeepSeek（Anthropic Messages API 兼容端点） |
| 数据库 | SQLite（Node 内置 `node:sqlite`，无需原生编译） |
