# iLink Bot Prototype (Mac Mini)

> 微信机器人本地原型：通过 iLink Bot API 收发微信消息，调用 Claude API 实现多轮对话完成价值观对齐/意图确认/画像采集。

## 当前状态

纯设计阶段，尚未编写实现代码。设计文档见 `ilink-bot-mac-mini-prototype.md`。

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
| 运行时 | Node.js ≥ 18（内置 `fetch`） |
| 微信接入 | 社区 SDK：`epiral/weixin-bot` 或 `the-yex/wechat-ilink-sdk`，或参照 wechatbot.dev 协议自实现 |
| LLM | Anthropic Claude Messages API + tool use |
| 数据库 | SQLite，通过 `better-sqlite3` 或 Node 内置 `node:sqlite` |
| 进程守护 | `launchd` 或 `pm2`（先手动跑，稳定后再上） |

## 目录结构（计划）

```
├── config/
│   └── questions.json       # 问题清单配置
├── src/
│   ├── ilink-client.js      # 长轮询、QR 登录、context_token 管理
│   ├── conversation.js      # buildSystemPrompt + handleIncomingMessage
│   ├── llm.js               # 封装 Claude API 调用 + tool 定义
│   ├── db.js                # SQLite 初始化 + CRUD
│   └── index.js             # 启动入口：登录 → 长轮询循环
├── data/
│   └── bot.sqlite           # 本地数据库文件
├── .env                     # ANTHROPIC_API_KEY 等
└── package.json
```

## 数据模型（4 张表）

- **users** (`id`, `wechat_uid`, `status`, `created_at`) — 隔离单位是 user_id；status: bound/completed/dropped
- **messages** (`id`, `user_id`, `role`, `content`, `created_at`) — user/assistant 消息记录
- **profile_fields** (`user_id`, `field`, `value`, `updated_at`) — key-value 画像，动态扩展
- **context_tokens** (`wechat_uid`, `token`, `updated_at`) — iLink 协议要求回复时带上

## 对话处理流程

```
handleIncomingMessage(msg):
  1. getOrCreateUser(senderId)
  2. saveContextToken(senderId, contextToken)
  3. saveMessage(user.id, "user", text)
  4. getRecentMessages(20) + getProfileFields + loadQuestionConfig()
  5. buildSystemPrompt(config, collected) → 组装 system prompt
  6. callClaude(system, history, tools) → 调用 Claude
  7. 处理 tool_calls：save_profile_field / mark_complete
  8. saveMessage(user.id, "assistant", response.text)
  9. sendMessage(senderId, response.text, contextToken)
```

Claude 工具定义：
- `save_profile_field(field, value)` — 记录收集到的画像字段
- `mark_complete()` — 标记对话完成

## 问题清单配置

`config/questions.json` 结构：
- `opening` — 开场白
- `required_fields` — 必收字段（如 `["name", "wechat_contact", "intent_confirmed"]`）
- `key_questions` — 需融入对话的问题列表
- `tone` — 语气（如 "轻松、口语化"）
- `strictness` — 宽松度（"lenient"）
- `close_when_complete` — 收齐后是否结束对话（控制轮次的关键开关）

## 运行方式

```bash
npm install
node src/index.js
# 首次运行打印二维码链接，扫码绑定
```

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
