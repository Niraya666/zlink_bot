# iLink Bot Prototype (Mac Mini)

> 微信机器人本地原型：通过 iLink Bot API 收发微信消息，调用 Claude API 实现多轮对话完成价值观对齐/意图确认/画像采集。

## 当前状态

v1 原型已跑通（扫码登录 → 多轮对话 → 网页控制台）。正在按 `docs/architecture-v2.md`
重塑为「可复用 core + 活动 pack」结构，进度见 `docs/dev-plan-v2.md`（Phase 1 已完成）。

设计文档：`ilink-bot-mac-mini-prototype.md`（v1 原始设计）、`docs/architecture-v2.md`（v2 架构）。

## 项目定位

在一台 Mac mini 上跑通「微信扫码绑定 → 多轮对话」最小闭环，验证 iLink Bot API + LLM 的可行性。不做组织者后台、不做落地页、不上云。

## 系统架构

三个组件都在本地 Mac mini 上运行，只有出站 HTTPS 流量，不需要入站端口/域名/反向代理：

```
微信用户 → iLink API (出站长轮询) → iLink 长轮询客户端 → 对话处理器 → Claude API
                                                              ↓
                                                          SQLite (本地)
```

- **iLink 长轮询客户端**：收发微信消息（QR 登录、context_token 管理、媒体加解密）
- **对话处理器**：拼 system prompt → 调 Claude Messages API + tool use → 处理工具调用（写画像/标记完成）→ 回复
- **SQLite**：用户绑定关系、会话历史、画像字段、context_token 缓存

## 技术栈

| 层 | 选型 |
|---|---|
| 运行时 | Node.js ≥ 22.5（内置 `fetch` 与 `node:sqlite`） |
| 微信接入 | 社区 SDK：`epiral/weixin-bot` 或 `the-yex/wechat-ilink-sdk`，或参照 wechatbot.dev 协议自实现 |
| LLM | Anthropic Claude Messages API + tool use |
| 数据库 | SQLite，使用 Node 内置 `node:sqlite`（无需原生编译；实现见 `src/db.js`） |
| 进程守护 | `launchd` 或 `pm2`（先手动跑，稳定后再上） |

## 目录结构

```
├── cli.js                   # 入口：run / list / export / relogin
├── activities/
│   └── <slug>/              # 活动 pack（配置的唯一事实来源）
│       ├── activity.json    # 元信息与开关（含可选 web_port）
│       ├── fields.json      # 字段 schema
│       └── flow.md          # 引导策略（frontmatter + prompt 正文）
├── core/
│   ├── activity.js          # pack 加载 + 校验 + 活动选择
│   ├── paths.js             # 项目路径（从模块位置解析，不依赖 cwd）
│   ├── run.js               # 编排：数据库 + 控制台 + 机器人
│   ├── channel/
│   │   ├── wechat.js        # 长轮询、QR 登录、context_token 管理
│   │   └── session.js       # 已保存登录态的检测与清除
│   ├── engine/
│   │   ├── conversation.js  # handleIncomingMessage + 工具调用校验
│   │   ├── prompt.js        # system prompt 渲染（flow.md 正文 + 运行时段落）
│   │   ├── tools.js         # 工具定义（buildTools，按 pack 动态生成）
│   │   └── llm.js           # 封装 LLM API 调用
│   ├── store/
│   │   └── db.js            # SQLite 初始化 + CRUD（按 event_id 作用域化）
│   └── dashboard/
│       └── server.js        # 网页控制台
├── data/
│   └── bot.sqlite           # 本地数据库文件
├── .env                     # DEEPSEEK_API_KEY 等
└── package.json
```

`core/` 内不含任何活动语义；活动特定的一切都在 `activities/<slug>/`。
Phase 5 将补 pack 内的 `tools.js`（自定义工具）与 `views/`（自定义结果页）逃生舱。

## 数据模型（5 张表）

- **events** (`id`, `name`, `created_at`) — `id` 即活动 slug；启动时 upsert 当前活动
- **users** (`id`, `event_id`, `wechat_uid`, `status`, `created_at`) — `(event_id, wechat_uid)` 联合唯一，
  即同一微信号在不同活动下是两个独立用户；status: bound/completed/dropped
- **messages** (`id`, `user_id`, `role`, `content`, `created_at`) — user/assistant 消息记录
- **profile_fields** (`user_id`, `field`, `value`, `updated_at`) — key-value 画像，动态扩展
- **context_tokens** (`wechat_uid`, `token`, `updated_at`) — iLink 协议要求回复时带上；
  属微信会话层而非活动层，故不带 `event_id`

`initDatabase({eventId, eventName})` 返回的接口已按活动作用域化，调用方不传 event_id。
旧库（缺 `event_id`）会在启动时自动备份为 `bot.sqlite.bak-<时间戳>` 并重建。

## 对话处理流程

```
handleIncomingMessage(msg):
  1. getOrCreateUser(senderId) + loadActivity()
  2. 已 completed/dropped → 回 activity.reentryMessage 并结束
  3. saveMessage(user.id, "user", text)
  4. getRecentMessages(20) + getProfileFields
  5. close_when_complete 且必收字段已齐 → 回 completionMessage 并结束（不调 LLM）
  6. renderSystemPrompt(activity, collected) + buildTools(activity)
  7. callClaude(system, history, tools) → 工具循环（上限 5 轮）
  8. applyToolCall 逐个校验并落库，把真实结果作为 tool_result 回传
  9. saveMessage(user.id, "assistant", response.text) → 回复用户
```

工具定义（由 `buildTools(activity)` 按 pack 动态生成）：
- `save_field(field, value)` — `field` 是 `fields.json` 的 key 枚举；
  schema 外的 key 拒绝写入并回传可用清单，布尔字段归一化为 `true`/`false`，
  歧义值拒绝并要求模型重判
- `mark_complete()` — 标记对话完成

## 活动 Pack 配置

活动配置的唯一事实来源是 `activities/<slug>/`，规范见 `docs/architecture-v2.md` §4：

- **activity.json** — `name`、`close_when_complete`、`reentry_message`、`completion_message`
- **fields.json** — `fields: [{key, label, type, required}]`；`key` 须 snake_case，
  `type` 限 `string` / `boolean`。同时驱动必收字段判定与 dashboard 列
- **flow.md** — frontmatter（`tone` / `strictness` / `opening`）+ 正文（引导策略 prompt）

`src/activity.js` 负责加载与校验：一次性列出全部错误并指明文件与字段。
活动选择用环境变量 `ACTIVITY`；只有一个 pack 时可省略，多个时不指定会报错拒绝启动。
`conversation.js` 每收一条消息重新加载 pack，改配置无需重启。

创建/修改/测试活动用 `.claude/skills/` 下的 `new-activity` / `edit-activity` / `test-activity`。

## 运行方式

```bash
npm install
npm start                          # activities/ 下只有一个活动时
node cli.js run <slug>             # 有多个活动时指定
node cli.js list                   # 活动清单 + 报名统计
node cli.js export <slug> --csv    # 导出报名数据
node cli.js relogin                # 清除登录态，强制重新扫码
# 首次运行打印二维码链接，扫码绑定
```

`npm link` 后可直接用 `zlink <命令>`。活动选择优先级：命令行参数 > `ACTIVITY`
环境变量 > 唯一 pack；多个 pack 且未指定时报错拒绝启动。

## 明确不做（当前阶段）

- 管理后台 / Web 落地页（不需要公网域名/ICP 备案）
- 多活动/多租户
- 云端部署/容器化
- 复杂打分模型

## 升级路径

验证通过后按需补：云主机迁移（Postgres 替代 SQLite）、组织者后台（需要域名+备案）、多活动拆分（event_id）、动态白名单、风控策略。

## 参考来源

- [WeChat iLink Bot Protocol](https://www.wechatbot.dev/en/protocol)
- [What is iLink?](https://allclaw.org/blog/what-is-ilink)
- [WeChat | Hermes Agent Docs](https://hermes-agent.nousresearch.com/docs/user-guide/messaging/weixin)
- [mee7 schema 参考](https://registry.npmjs.org/@ha7ch/mee7)
