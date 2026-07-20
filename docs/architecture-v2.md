# 架构设计 v2：可复用 Core + 活动 Pack

> 状态：设计稿（2026-07-18）
> 前置：v1 原型已跑通「微信扫码绑定 → 多轮对话采集画像」最小闭环（见 `CLAUDE.md`）。
> 本文档定义从单活动原型到多活动可复用结构的重塑方案。

## 1. 背景与动机

v1 的目标是验证 iLink Bot API + LLM 的可行性，只服务一场活动。验证已通过，
下一阶段的现实需求是：**活动是多样的**——不同活动的引导策略、必收字段、
收尾方式、结果页面都不同，但接微信、跑对话循环、存数据、看后台这些能力
是完全一致的。

v1 名义上把活动配置收敛在 `config/questions.json`，实际上活动语义散落在
core 代码里：

| 位置 | 泄漏内容 |
|---|---|
| `src/conversation.js` | system prompt 模板写死「活动报名助手 / 价值观方向」叙事；收尾话术硬编码 |
| `src/db.js` `getUserSummaries()` | SQL 里写死 `name` / `wechat_contact` / `intent_confirmed` 三个字段名 |
| `src/db.js` 数据模型 | `users` / `messages` 无 `event_id`，天然单活动 |
| `src/server.js` | dashboard 列与上面写死的字段一一对应 |

换一个活动，这四处都要改代码。重塑的目标就是把这条边界画清楚。

## 2. 核心决策

**「core + skills」与「CLI」不是二选一。** 它们回答两个不同的问题：

- core + activity pack —— 代码的组织方式：什么可复用、什么随活动变化
- CLI —— 操作界面：怎么创建、运行、管理活动

**决策：以 core + activity pack 为主体结构，CLI 作为其上的一层薄壳。**

其余关键判断：

1. **引导策略用 Markdown（`flow.md`），不用 JSON 编排对话流。**
   对话引导本质是 prompt，不是状态机。用 JSON 定义对话分支会演化成一个
   蹩脚的 DSL。参考 Claude Code 的 SKILL.md 模式：frontmatter 放结构化
   开关，正文自由书写引导策略。
2. **字段 schema（`fields.json`）是 core 与 pack 的核心契约。**
   同一份 schema 驱动三处：prompt 中的必收字段清单、`save_field` 工具的
   校验、dashboard 的列与结果页。「最终页面的差异」大部分是字段差异，
   schema 驱动覆盖约 80%；真正定制的页面用 pack 内模板覆盖。
3. **声明式为主，`tools.js` 做逃生舱。**
   多数活动只需配置；个别活动需要代码（查余票、发定制内容），pack 内
   导出工具定义，core 动态 import 并合并。
4. **辅助配置活动 = 仓库内的 Claude Code skills，不自建访谈 agent。**
   Claude Code 本身具备 LLM + 文件工具 + 多轮对话能力，pack 又全是明文
   文件——在 `.claude/skills/` 放访谈式生成/修改/测试的 skill 即可，
   不需要在 CLI 里重造一个 LLM 访谈运行时（原 `zlink create` 方案作废）。
5. **一号一活动，先不做入口路由。**
   iLink 一次登录绑一个微信号。多活动共用一号需要关键词/带参二维码路由，
   复杂度陡增。初期一进程一活动一微信号（`zlink run <activity>`），
   数据库预埋 `event_id`，未来可合并。

## 3. 目标结构

```
zlink/
├── core/                        # 可复用引擎，不含任何活动语义
│   ├── channel/
│   │   └── wechat.js            # iLink 接入：QR 登录、收发、会话生命周期
│   ├── engine/
│   │   ├── loop.js              # 对话循环：历史 + prompt 渲染 + tool 分发
│   │   ├── prompt.js            # flow.md 渲染：注入已收集字段/缺失字段
│   │   └── tools.js             # 内置工具：save_field / mark_complete
│   ├── store/
│   │   └── db.js                # SQLite；查询按 event_id + schema 驱动
│   └── dashboard/
│       ├── server.js            # HTTP 框架：状态 / QR / 用户列表
│       └── views.js             # 默认视图；列由 fields.json 生成
│
├── activities/                  # 每个活动一个 pack
│   └── demo-day-2026/
│       ├── activity.json        # 元信息与开关
│       ├── flow.md              # 引导策略（prompt）
│       ├── fields.json          # 字段 schema
│       ├── tools.js             # （可选）活动特有工具
│       └── views/               # （可选）dashboard 差异化页面模板
│
├── cli.js                       # zlink create | run | list | export
├── data/                        # 运行时数据（SQLite）
└── docs/
    └── architecture-v2.md       # 本文档
```

## 4. Activity Pack 规范

一个 pack 就是 `activities/<slug>/` 目录。core 启动时加载并校验，缺必需
文件即拒绝启动并给出明确报错。

### 4.1 `activity.json` — 元信息与开关（必需）

```json
{
  "name": "Demo Day 2026",
  "slug": "demo-day-2026",
  "starts_at": "2026-08-01",
  "close_when_complete": true,
  "reentry_message": "你之前已经完成过对话啦，如有疑问请联系活动组织者～",
  "completion_message": "好啦，你的信息我都记下了！感谢配合，如有变动随时联系我～"
}
```

- `close_when_complete` — 必收字段收齐后是否自动结束（v1 语义不变）
- `reentry_message` / `completion_message` — v1 中硬编码在
  `conversation.js` 的话术，移入配置
- `web_port`（可选）— 控制台端口，默认 3000；同时跑多场活动时靠它避开冲突
- `starts_at`（可选）— 活动日期，目前仅作元信息

### 4.2 `fields.json` — 字段 schema（必需）

```json
{
  "fields": [
    {
      "key": "name",
      "label": "姓名",
      "type": "string",
      "required": true
    },
    {
      "key": "wechat_contact",
      "label": "微信号",
      "type": "string",
      "required": true
    },
    {
      "key": "intent_confirmed",
      "label": "确认参加",
      "type": "boolean",
      "required": true
    },
    {
      "key": "arrival_time",
      "label": "预计到场时间",
      "type": "string",
      "required": false
    }
  ]
}
```

驱动三处，保持单一事实来源：

1. **prompt** — 必收字段清单、已收集/缺失状态注入 `flow.md` 渲染
2. **工具校验** — `save_field` 只接受 schema 内的 `key`；`type` 做轻量
   规范化（如 boolean 归一化为 `"true"`/`"false"`）
3. **dashboard** — 用户列表的列 = `required` 字段 + 完成状态；
   `label` 作为表头

存储仍是 key-value（`profile_fields` 表），schema 只在应用层生效，
加字段不需要迁移。

### 4.3 `flow.md` — 引导策略（必需）

```markdown
---
tone: 轻松、口语化，别像在做问卷
strictness: lenient
opening: 嗨，我是活动小助手。花两分钟聊聊，我帮你确认一下参加资格～
---

你是 Demo Day 的报名助手。自然地聊天，同时完成三件事：

1. 传达活动的价值观方向，观察对方是否认同（不用打分，先记录印象）
2. 确认对方是否会来参加
3. 收集必要信息

对话中融入这些问题（不用逐条照念）：

- 你是怎么知道这场活动的？
- 你对活动主题怎么看？
- 你确认能来现场吗？大概几点到？
```

渲染规则（`core/engine/prompt.js`）：

- frontmatter 为结构化参数；正文为 prompt 主体
- core 在正文后追加统一的「运行时段落」：已收集字段、缺失字段、
  工具调用规则（v1 `buildSystemPrompt` 中与活动无关的部分）
- 正文完全由活动作者掌控——不同活动的引导差异可以任意大

### 4.4 `tools.js` — 活动特有工具（可选）

```js
// activities/demo-day-2026/tools.js
export const tools = [
  {
    name: "check_seat_availability",
    description: "查询当前剩余名额",
    input_schema: { type: "object", properties: {}, required: [] },
    async handler(input, ctx) {
      // ctx: { db, user, activity }
      return `当前剩余名额：${await countSeats(ctx.db)}`;
    },
  },
];
```

core 动态 import，与内置工具合并后传给 LLM；`handler` 返回值作为
tool_result 回传。内置工具名（`save_field` / `mark_complete`）保留，
pack 不可覆盖。

### 4.5 `views/` — dashboard 差异化页面（可选）

默认 dashboard 由 schema 生成即可用。需要定制结果页时，pack 提供模板
（如 `views/summary.html`），core 检测到即替换默认页面，模板内可访问
schema 化的用户数据。首期只支持整页替换，不做模板语言。

## 5. Core 契约

core 对 pack 暴露的稳定接口（pack 只依赖这些，不 import core 内部模块）：

| 契约 | 内容 |
|---|---|
| Pack 加载 | 目录结构 + 三个必需文件的 JSON/frontmatter schema |
| 工具协议 | `{ name, description, input_schema, handler(input, ctx) }` |
| handler ctx | `{ db, user, activity }`——db 为按 `event_id` 作用域化的只读+字段写入接口 |
| 视图数据 | `{ activity, fields, users: [{ status, collected: {...} }] }` |

内置工具从 v1 的 `save_profile_field` 更名为 `save_field`（参数
`field, value` 不变），并增加 schema 校验；`mark_complete` 语义不变。

## 6. 数据模型变更

在 v1 四张表基础上：

```sql
-- 新增
CREATE TABLE IF NOT EXISTS events (
  id         TEXT PRIMARY KEY,        -- = activity slug
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- users 增加 event_id；用户按活动隔离
-- (event_id, wechat_uid) 联合唯一，替代原 wechat_uid 全局唯一
ALTER TABLE users ADD COLUMN event_id TEXT NOT NULL DEFAULT '';
```

- `messages` / `profile_fields` 经 `user_id` 关联，天然继承活动隔离，
  不需要加列
- `context_tokens` 属于微信会话层而非活动层，保持不变
- `getUserSummaries()` 重写为：读 `fields.json` → 动态生成
  `MAX(CASE WHEN ...)` 投影，或直接在应用层组装（数据量小，首选后者，
  SQL 更简单）

原型阶段数据不做迁移脚本：现有 `data/bot.sqlite` 可直接删除重建。

## 7. CLI

```
zlink run <activity>     # 启动某活动：加载 pack → 登录 → 长轮询 + dashboard
zlink list               # 列出 activities/ 下的 pack 及其数据统计
zlink export <activity>  # 导出报名数据（JSON / CSV）
```

活动的创建与修改不在 CLI 里做，由 Claude Code skills 承担（见 §8）。

- `cli.js` 是薄壳：解析参数 → 调 core。`npm start` 保留为
  `zlink run <默认活动>` 的别名以兼容习惯
- 一进程一活动。同时跑多场活动 = 多个进程 + 多个微信号，
  dashboard 端口在 `activity.json` 或环境变量中区分

## 8. 辅助配置活动 —— Claude Code Skills

配置活动不写专门的运行时，直接以仓库内 skills 的形式交付
（`.claude/skills/`）。组织者在 Claude Code 里对话即可完成
创建、修改、上线前测试三件事：

| Skill | 用途 |
|---|---|
| `new-activity` | 访谈式创建：2–3 轮提问（活动性质 → 收什么信息 → 对话风格），生成 `activities/<slug>/` 全套文件 |
| `edit-activity` | 修改已有 pack：摘要展示现状 → 应用修改；含字段重命名的数据兼容警告 |
| `test-activity` | 上线前模拟：按运行时方式组装 prompt，角色扮演走完对话（支持自动测试三种参与者画风），输出字段覆盖/引导质量报告 |

选择这条路的原因：

1. **不重造轮子**：访谈需要的 LLM、多轮对话、文件读写，Claude Code 全都有；
   自建 `zlink create` 等于维护第二个 agent 运行时
2. **pack 是明文**：skill 只是引导生成文件，产物永远可以手改，
   生成器不是唯一入口
3. **测试免费获得**：`test-activity` 的角色扮演式验证在 CLI 方案里
   很难做得同样自然

**校验闭环**：`new-activity` / `edit-activity` 在写完文件后都会调用加载器
（`loadActivity(slug)`）验证一遍——加载器会一次性列出全部问题并指明文件与字段，
所以配置错误在生成时就被拦住，而不是等到启动才炸。

> v1 兼容桥（向 `config/questions.json` 同步）已随 Phase 2 移除：运行时现在只读
> activity pack，`config/questions.json` 不再存在。

**注意**：skills 生成的是配置，真实运行时的模型是 DeepSeek——
`test-activity` 检验的是 prompt 设计本身，不能完全代表线上模型表现。

## 9. 迁移路径

每步独立可用、可单独提交：

| 步骤 | 内容 | 验证 |
|---|---|---|
| 1 | `events` 表 + `users.event_id`；`getUserSummaries` 改为应用层按 schema 组装 | dashboard 在字段任意变化下正确展示 |
| 2 | `config/questions.json` → `activities/demo-day-2026/`（拆为 activity.json + fields.json + flow.md）；实现 pack 加载与校验 | 现有对话流程行为不变 |
| 3 | prompt 模板移出 `conversation.js`，改为 flow.md 渲染 + 运行时段落追加；话术移入 activity.json | 与 v1 对话逐轮对比无回归 |
| 4 | 目录重排为 core/；加 `cli.js`（run / list / export） | `zlink run demo-day-2026` 完整跑通扫码登录 |
| 5 | `tools.js` 逃生舱 + `views/` 覆盖机制 | 示例活动自定义一个工具与结果页 |
| 6 | ~~`zlink create`~~ 已由 Claude Code skills 取代，先行落地（含 v1 兼容桥），不依赖前序步骤 | 用 `new-activity` 从零生成活动并在 v1 运行时跑通 |

注：步骤 6 的 skills 已随本文档落地（`.claude/skills/`），可立即使用；
步骤 2 完成后需同步移除 skills 中的 v1 兼容桥逻辑。

## 10. 明确不做（本阶段）

- 多活动共用一个微信号的入口路由（关键词 / 带参二维码）
- 模板语言、前端框架——dashboard 保持无依赖原生 HTML
- 云端部署、Postgres、多租户（沿用 v1 的升级路径，触发条件不变）
- pack 的版本管理 / 市场化分发——pack 就是 git 里的目录

## 11. 风险与开放问题

- **schema 校验的严格度**：LLM 偶尔会用 schema 外的 `key` 调
  `save_field`。首期策略：拒绝并在 tool_result 中回传可用字段清单，
  让模型自行纠正；观察实际错误率再决定是否需要模糊匹配
- **flow.md 的自由度 vs 可生成性**：`new-activity` skill 生成的 prompt
  质量依赖访谈设计；跑过 2–3 场真实活动后，把打磨好的 pack 作为范例
  沉淀进 SKILL.md，持续提升生成质量
- **`@wechatbot/wechatbot` SDK 的坑**：`loginCallbacks` 只在
  `run()/login()` 参数中生效（构造函数中被忽略），封装进
  `core/channel/wechat.js` 时保持 v1 的正确用法并保留注释
