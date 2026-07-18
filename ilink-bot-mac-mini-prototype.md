# ilink bot 小实验设计文档（Mac mini 本地原型）

> 定位：在一台 Mac mini 上跑通「微信扫码绑定 → 多轮对话完成价值观对齐 / 意图确认 / 画像采集」的最小闭环，验证 iLink Bot API + LLM 的可行性，不做组织者后台、不做落地页、不上云。

## 一、范围界定

**这一版要做的：**

- 一个 Mac mini 本地进程，长轮询 iLink API 收发微信消息
- 一个无状态对话处理函数：拼 system prompt → 调 LLM → 写本地数据库 → 回复
- 一个本地 SQLite，存用户绑定关系、会话历史、已采集画像
- 一份可配置的「问题清单」JSON，定义价值观问题 + 意图确认口径 + 必收字段

**这一版不做的（等验证完核心链路再说）：**

- 组织者管理后台 / Web 落地页（不需要公网域名，也就不涉及 ICP 备案）
- 多活动/多租户支持
- 云端部署、容器化、水平扩容
- 复杂打分模型（先用最简单的「必收字段是否收齐」判断对话是否结束）

## 二、系统组成

```
┌─────────────────────────────────────────────┐
│                  Mac mini                     │
│                                                │
│  ┌──────────────┐      ┌───────────────────┐ │
│  │ iLink 长轮询   │─────▶│  对话处理器         │ │
│  │ 客户端        │◀─────│ (system prompt +   │ │
│  │ (收/发消息)    │      │  LLM 调用 + 工具)   │ │
│  └──────────────┘      └─────────┬─────────┘ │
│         ▲                        │            │
│         │ 出站长轮询               ▼            │
│         │                  ┌───────────┐      │
│         │                  │ SQLite    │      │
│         │                  └───────────┘      │
└─────────┼──────────────────────────────────────┘
          │  HTTPS（无入站流量，无需公网域名/穿透）
          ▼
  ilinkai.weixin.qq.com
```

不需要反向代理、不需要 nginx、不需要暴露任何端口——Mac mini 只主动发 HTTPS 请求出去。

## 三、技术栈

跟 mee7 的思路一致：越薄越好，先别引入框架。

| 层 | 选型 | 理由 |
|---|---|---|
| 运行时 | Node.js ≥ 18（内置 fetch） | 零依赖起步，iLink 社区 SDK 也以 Node/TS 最成熟 |
| 微信接入 | 直接用 `epiral/weixin-bot` 或 `the-yex/wechat-ilink-sdk`；实在要自己实现，参照 wechatbot.dev 的协议文档 | 避免自己啃 QR 登录状态机、context_token 管理、AES-128-ECB 媒体加解密这些细节 |
| LLM | Anthropic Claude API，直接调 Messages API + tool use | 跟 system prompt/工具调用模式最贴合 |
| 数据库 | SQLite（`better-sqlite3` 或 Node 内置 `node:sqlite`） | 小实验阶段没必要上 Postgres/Supabase，单文件、零运维 |
| 进程守护 | `launchd`（macOS 原生）或 `pm2` | 防止意外退出后没人拉起来；小实验阶段可以先手动跑，观察稳定后再上守护 |

## 四、数据模型（SQLite）

```sql
-- 用户绑定关系：微信身份 <-> 内部用户
CREATE TABLE users (
  id            TEXT PRIMARY KEY,      -- 内部 user_id，uuid
  wechat_uid    TEXT UNIQUE NOT NULL,  -- iLink 消息里的发送者 ID
  status        TEXT NOT NULL DEFAULT 'bound', -- bound / completed / dropped
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 会话历史，一行一条消息
CREATE TABLE messages (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       TEXT NOT NULL REFERENCES users(id),
  role          TEXT NOT NULL,   -- user / assistant
  content       TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 已采集的画像字段，key-value，方便动态扩展问题清单
CREATE TABLE profile_fields (
  user_id       TEXT NOT NULL REFERENCES users(id),
  field         TEXT NOT NULL,   -- 如 name / values_alignment / intent_confirmed / wechat_note
  value         TEXT NOT NULL,
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, field)
);

-- context_token 缓存（协议要求：回复必须带上收到消息时的 token）
CREATE TABLE context_tokens (
  wechat_uid    TEXT PRIMARY KEY,
  token         TEXT NOT NULL,
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
```

隔离单位就是 `user_id` 这一行——不需要进程、容器、profile 级别的隔离，跟前面结论一致。

## 五、问题清单配置（参考 mee7 门规 schema，简化版）

```json
{
  "opening": "嗨，我是活动小助手。花两分钟聊聊，我帮你确认一下参加资格～",
  "required_fields": ["name", "wechat_contact", "intent_confirmed"],
  "key_questions": [
    "你是怎么知道这场活动的？",
    "你对活动主题（写你的价值观方向）怎么看？",
    "你确认能来现场吗？大概几点到？"
  ],
  "tone": "轻松、口语化，别像在做问卷",
  "strictness": "lenient",
  "close_when_complete": true
}
```

`close_when_complete: true` 对应 mee7 的「聊完清单就收尾，不硬撑轮次」——这是控制对话轮数、避免用户体验变差的关键开关。

## 六、对话处理流程（伪代码）

```js
async function handleIncomingMessage(msg) {
  // msg: { senderId, text, contextToken }
  const user = getOrCreateUser(msg.senderId);
  saveContextToken(msg.senderId, msg.contextToken);
  saveMessage(user.id, "user", msg.text);

  const history = getRecentMessages(user.id, 20);
  const collected = getProfileFields(user.id);
  const config = loadQuestionConfig();

  const systemPrompt = buildSystemPrompt(config, collected);

  const response = await callClaude({
    system: systemPrompt,
    messages: history,
    tools: [saveProfileFieldTool, markCompleteTool],
  });

  // 处理工具调用：LLM 决定"这轮该记录什么字段"
  for (const call of response.toolCalls) {
    if (call.name === "save_profile_field") {
      saveProfileField(user.id, call.input.field, call.input.value);
    }
    if (call.name === "mark_complete") {
      updateUserStatus(user.id, "completed");
    }
  }

  saveMessage(user.id, "assistant", response.text);
  await sendMessage(msg.senderId, response.text, msg.contextToken);
}
```

`buildSystemPrompt` 大致长这样：

```
你是活动报名助手。你的任务是自然地聊天，同时完成三件事：
1. 传达活动的价值观方向，观察对方是否认同（不用打分，先记录印象）
2. 确认对方是否会来参加
3. 收集这些信息：{required_fields}

已经收集到的信息：{collected}
还差：{missing_fields}

问题清单（不用逐条照念，融进对话里问）：{key_questions}

语气要求：{tone}

规则：
- 每轮只问 1-2 个问题，别一次甩一堆
- 该记录信息时调用 save_profile_field 工具
- 必收字段都收齐后，调用 mark_complete，然后自然收尾，别继续硬聊
```

## 七、目录结构建议

```
ilink-bot-prototype/
├── config/
│   └── questions.json          # 第五节的问题清单配置
├── src/
│   ├── ilink-client.js         # 长轮询、QR 登录、context_token 管理
│   ├── conversation.js         # buildSystemPrompt + handleIncomingMessage
│   ├── llm.js                  # 封装 Claude API 调用 + tool定义
│   ├── db.js                   # SQLite 初始化 + 各表读写函数
│   └── index.js                # 启动入口：登录 -> 进入长轮询循环
├── data/
│   └── bot.sqlite               # 本地数据库文件
├── .env                          # ANTHROPIC_API_KEY 等
└── package.json
```

## 八、运行方式

```bash
npm install
node src/index.js
# 首次运行会打印二维码链接，扫码绑定这台 Mac mini 上的微信身份
# 之后其他人直接加这个微信为好友、发消息，就会进入对话流程
```

不需要任何端口监听、不需要域名、不需要在路由器上做端口转发。

## 九、从小实验到正式上线的升级路径

小实验跑顺了之后，如果要正式对外用，按需补这几块（不是必须一次做完）：

| 需要的能力 | 触发条件 | 怎么补 |
|---|---|---|
| 更大并发/更高可用性 | 单台 Mac mini 撑不住，或不能接受单点故障 | 迁移到云主机或 Serverless，SQLite 换成托管 Postgres |
| 组织者后台/落地页 | 需要人工复核画像、需要可分享的活动页 | 这时才需要公网域名 + ICP 备案 + 云托管 |
| 多活动/多租户 | 同时跑多场活动，问题清单不同 | `profile_fields`/`questions.json` 按 event_id 拆分 |
| 动态白名单 | 防止绑定后被滥用/骚扰 | 应用层加一层「绑定审核」逻辑，别依赖 iLink 默认行为 |
| 大量陌生人加好友风控 | 灰度测试发现触发微信风控 | 控制加好友频率、观察账号状态，必要时申请更高权限或走 WeCom |

## 十、参考来源

- [Protocol — WeChat iLink Bot API](https://www.wechatbot.dev/en/protocol)
- [What is iLink? Tencent WeChat Official Bot API for OpenClaw](https://allclaw.org/blog/what-is-ilink)
- [Weixin (WeChat) | Hermes Agent 官方文档](https://hermes-agent.nousresearch.com/docs/user-guide/messaging/weixin)
- [@ha7ch/mee7 — npm registry](https://registry.npmjs.org/@ha7ch/mee7)（门规 schema 参考来源）
