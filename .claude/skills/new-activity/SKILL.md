---
name: new-activity
description: 访谈式创建一个新的活动 pack。当用户想新建/配置一场活动（报名、招募、邀请制聚会等）时使用，通过几轮提问收集活动信息，生成 activities/<slug>/ 下的全套配置文件。
---

# 创建新活动 pack

通过访谈组织者（当前用户），生成一个完整的 activity pack。
Pack 规范的权威定义见 `docs/architecture-v2.md` §4，本 skill 内的模板与其保持一致。

## 流程

### 1. 访谈

分 2–3 轮提问，每轮聚焦一个主题，不要一次甩十个问题，也不要一条一条问：

**第一轮 — 活动本身：**
- 活动名称、日期
- 活动是什么性质的（讲座 / 聚会 / 招募 / 邀请制活动…）
- 对话的目标是什么（确认参加、筛选人、纯登记信息…）

**第二轮 — 要收集什么：**
- 需要从参与者那里收集哪些信息（推导 fields.json）
- 哪些是必收的、哪些可选
- 是否有需要「观察/判断」而非直接询问的（如价值观认同度）——这类进 flow.md 的引导策略，不进必收字段

**第三轮 — 对话风格：**
- 语气（给出建议默认值：轻松、口语化）
- 开场白想怎么说（可以代拟后确认）
- 收齐信息后是自动收尾还是继续闲聊（`close_when_complete`）

用户如果一开始就给了完整信息，跳过对应轮次，不要为了走流程而重复提问。

### 2. 推导 slug 并检查冲突

- slug 用 kebab-case 英文（如 `demo-day-2026`），从活动名+年份推导，向用户确认
- 检查 `activities/<slug>/` 是否已存在，存在则提示换名或改用 edit-activity skill

### 3. 生成文件

创建 `activities/<slug>/`，写入三个文件：

**activity.json**
```json
{
  "name": "<活动名>",
  "slug": "<slug>",
  "starts_at": "<YYYY-MM-DD>",
  "close_when_complete": true,
  "reentry_message": "<重入提示话术>",
  "completion_message": "<完成收尾话术>"
}
```

可选端口字段（只在需要多活动并行时才加，否则省略走默认）：
`join_port`（参与者页面，默认 3001）、`web_port`（控制台，默认 3000）。
两者不能相同，加载器会校验。

**fields.json** — 字段 key 用 snake_case 英文；`label` 用中文；`type` 限 `string` / `boolean`：
```json
{
  "fields": [
    { "key": "name", "label": "姓名", "type": "string", "required": true }
  ]
}
```

**flow.md** — frontmatter 放 `tone` / `strictness` / `opening`；正文是给报名助手的引导策略，
用第二人称写（"你是……的报名助手"），包含：对话目标、需融入对话的问题清单、需观察判断的维度。
正文不要包含字段清单和工具调用规则——那些由 core 运行时追加。

### 3b. 逃生舱（可选，多数活动用不到）

在访谈里加一问：**这场活动需不需要配置覆盖不了的东西**？两种逃生舱，需要才生成：

- **自定义工具** `tools.js` —— 当引导过程中需要执行代码（查实时余额/名额、发定制内容、
  调外部接口）时。参照 `activities/example-with-tools/tools.js`：
  `export const tools = [{ name, description, input_schema, handler(input, ctx) }]`，
  `ctx = { db, user, activity }`（db 已按本活动作用域化）。工具名不能是 `save_field` /
  `mark_complete`，且要在 flow.md 正文里明确告诉助手何时调用它。
- **自定义结果页** `views/summary.html` —— 当默认 dashboard 的表格满足不了展示需求时。
  存在即整页替换 `/`；core 会注入 `window.__ZLINK__ = { eventName, fields }`，
  `/api/users`、`/api/status`、`/api/qrcode` 端点照常可用。参照 `example-with-tools/views/summary.html`。

不确定要不要用时，默认不用——声明式配置能覆盖绝大多数活动。

### 4. 校验

用 CLI 确认 pack 合法——它会一次性列出所有问题，每条指明文件和字段：

```bash
node cli.js list
```

新活动那行显示 `✗ <slug> — 配置有误` 就按报错逐条修，直到变成 `● <slug>`。
（`list` 只校验三件套；若加了 `tools.js`，它的错误要到启动时才报出。）

### 5. 收尾

- 打印生成的文件清单和内容摘要（字段表 + 开场白 + 关键开关）
- 说明两种启动方式的区别：

  | 命令 | 用途 |
  |---|---|
  | `node cli.js serve <slug>` | 对外报名：每个参与者打开页面各自扫码建立独立绑定 |
  | `node cli.js run <slug>` | 本地自测：你自己扫一次码 |

- 若 `activities/` 下已不止一个活动，提醒启动时必须带 slug，并建议在
  `activity.json` 里给不同活动设不同端口，避免并行时冲突：
  - `join_port` — 参与者页面（默认 3001，**对外，隧道指向它**）
  - `web_port` — 运营者控制台（默认 3000，**无鉴权，绝不能暴露**）

- 建议接下来用 test-activity skill 模拟一遍对话，检验引导效果
- 要真的开跑一场，照 `docs/runbook-live-test.md` 操作（防休眠、隧道、排障）
