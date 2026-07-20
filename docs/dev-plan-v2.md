# v2 开发计划清单

> 状态：进行中（2026-07-20 制定）
> 依据：`docs/architecture-v2.md`（尤其 §9 迁移路径）
> 原则：每个 Phase 独立可用、独立提交；任何时刻 `main` 都能跑通完整扫码登录 + 对话流程。

## 总览

| Phase | 内容 | 状态 | 依赖 |
|---|---|---|---|
| 0 | Claude Code skills（配置活动） | ✅ 已完成（7549e75） | 无 |
| 1 | 数据层：event_id + schema 驱动 | ✅ 已完成 | 无 |
| 2 | Activity pack：目录结构 + 加载校验 | ⬜ 未开始 | Phase 1 |
| 3 | Prompt 渲染：flow.md 接管对话策略 | ⬜ 未开始 | Phase 2 |
| 4 | 目录重排 core/ + CLI | ⬜ 未开始 | Phase 3 |
| 5 | 逃生舱：tools.js + views/ | ⬜ 未开始 | Phase 4 |

每个 Phase 完成即提交（一个 Phase 一个或多个 commit），合并前用真实扫码流程回归一次。

---

## Phase 1 — 数据层：event_id + schema 驱动

**目标**：拔掉 `db.js` 里的活动硬编码，为多活动预埋数据模型。

- [x] 1.1 新建 `events` 表（`id`=slug, `name`, `created_at`），启动时 upsert 当前活动
- [x] 1.2 `users` 表加 `event_id` 列；唯一约束改为 `(event_id, wechat_uid)` 联合唯一。
      旧库不做迁移：检测到缺 `event_id` 即自动备份为 `bot.sqlite.bak-<时间戳>` 后重建（数据可恢复）
- [x] 1.3 `db.js` 按 `event_id` 作用域化——`initDatabase({eventId, eventName})` 返回的接口
      隐式绑定该活动，调用方不传 eventId，天然无法跨活动读写
- [x] 1.4 `getUserSummaries()` 去掉写死的 `MAX(CASE WHEN ...)` 投影，改为应用层组装，
      返回 `{wechat_uid, status, created_at, collected:{...}}`；SQL 中不再出现任何字段名
- [x] 1.5 dashboard 列由字段清单注入渲染（`const FIELDS` 注入页面 + 表头用 label）
- [x] 1.6（追加）抽出 `src/config.js` 统一加载配置，产出 `eventId/eventName/fields`——
      Phase 2 activity loader 的前身；`conversation.js` 改用它，消除重复的 loader

**验收**：✅ 已验证。改 `required_fields` + `field_labels`（改名/增/删），dashboard 列自动跟随，
`src/` 零改动；跨活动同一 `wechat_uid` 互相隔离；真实 `npm start` 全链路通过。

**本阶段字段清单临时来自 `config/questions.json`**（新增 `event_id`/`event_name`/`field_labels` 三个键，
它们在 Phase 2 分别迁往 `activity.json` 的 slug/name 与 `fields.json` 的 label）。

---

## Phase 2 — Activity pack：目录结构 + 加载校验

**目标**：`activities/<slug>/` 成为活动配置的唯一事实来源。

- [ ] 2.1 手工创建第一个 pack `activities/demo-day-2026/`：
      把 `config/questions.json` 拆为 `activity.json` + `fields.json` + `flow.md`（格式见架构文档 §4）
- [ ] 2.2 实现 pack 加载器（`src/activity.js`，Phase 4 再挪进 core/）：
      读目录 → 解析三个文件（flow.md 用简单 frontmatter 解析，不引依赖）→ 返回统一 activity 对象
- [ ] 2.3 加载校验：缺文件 / JSON 非法 / 字段 key 非 snake_case / type 不在 string|boolean → 启动即报错，错误信息指明文件和字段
- [ ] 2.4 `conversation.js` / `index.js` / `server.js` 改为从 activity 对象取配置；
      `close_when_complete`、重入话术、完成话术从 `activity.json` 读取（替换硬编码）
- [ ] 2.5 活动选择：环境变量 `ACTIVITY`（默认取 `activities/` 下唯一的 pack；多个且未指定则报错）
- [ ] 2.6 删除 `config/questions.json`；**同步删除 skills 里的 v1 兼容桥**：
      `new-activity` SKILL.md §4、`edit-activity` 第 4 步、架构文档 §8 的桥说明
- [ ] 2.7 用 `new-activity` skill 生成一个第二活动，验证加载器对生成产物的兼容性

**验收**：现有对话行为不变（同样的开场白、字段收集、收尾）；故意写坏 fields.json 能得到可读的启动报错。

---

## Phase 3 — Prompt 渲染：flow.md 接管对话策略

**目标**：`buildSystemPrompt` 里的活动叙事移入 flow.md，core 只追加运行时段落。

- [ ] 3.1 实现渲染器（`src/prompt.js`）：flow.md 正文原样作为 prompt 主体，
      frontmatter（tone/strictness/opening）+ 运行时段落（已收集字段、缺失字段、工具规则）由 core 统一追加
- [ ] 3.2 `conversation.js` 删除 `buildSystemPrompt` 的活动叙事部分，改调渲染器
- [ ] 3.3 工具更名：`save_profile_field` → `save_field`（llm.js 工具定义 + conversation.js 分发处），
      并按 `fields.json` 校验 key：schema 外的 key 拒绝写入，tool_result 回传可用字段清单让模型自纠
- [ ] 3.4 boolean 类型字段值规范化（"是/对/确认" → "true"）——先做最简映射，复杂情况交给模型重试
- [ ] 3.5 回归：用 `test-activity` skill 对 demo-day-2026 跑三种画风（配合/敷衍/跑题）的自动测试，
      对比 v1 行为无退化；再用真实微信账号走一轮完整对话

**验收**：flow.md 正文任意改写（换一种活动叙事）后，无需动 src/ 代码即可生效；schema 外字段被正确拒绝。

**风险**：DeepSeek 对 save_field 校验失败的自纠能力未知——若实测纠错率低，回退方案是宽松模式（记录但标记 unknown 字段）。

---

## Phase 4 — 目录重排 core/ + CLI

**目标**：物理结构对齐架构文档 §3，入口变为 CLI。

- [ ] 4.1 目录迁移（`git mv` 保留历史）：
      `src/ilink-client.js` → `core/channel/wechat.js`（**保留 loginCallbacks 只在 run()/login() 生效的注释，
      以及 session_expired 不翻 waiting_qr 的处理**——两个已修过的坑不要在搬家时丢掉）
      `src/conversation.js` + `src/prompt.js` → `core/engine/`
      `src/llm.js` 工具部分 → `core/engine/tools.js`
      `src/db.js` → `core/store/db.js`
      `src/server.js` → `core/dashboard/server.js`
      `src/activity.js` → `core/activity.js`
- [ ] 4.2 `cli.js`：`run <activity>` / `list` / `export <activity>`（export 出 JSON + CSV 两种）
- [ ] 4.3 `src/relogin.js` 并入 CLI：`zlink relogin`（保留 `npm run relogin` 别名）
- [ ] 4.4 `package.json`：`bin` 字段注册 `zlink`；`npm start` 改为 `zlink run` 的别名
- [ ] 4.5 dashboard 端口进 `activity.json`（可选字段 `web_port`，默认 3000），支持多进程并行跑多活动
- [ ] 4.6 文档同步：README、CLAUDE.md 的目录结构 / 运行方式全部更新

**验收**：`npx zlink run demo-day-2026` 完整跑通扫码登录 + 对话 + dashboard；`zlink export` 产出的 CSV 可用表格软件打开。

---

## Phase 5 — 逃生舱：tools.js + views/

**目标**：给「配置覆盖不了的 20%」留出口。

- [ ] 5.1 pack 内 `tools.js` 动态 import；工具协议 `{ name, description, input_schema, handler(input, ctx) }`，
      ctx = `{ db, user, activity }`（db 为按 event_id 作用域化的受限接口）
- [ ] 5.2 名字冲突保护：pack 工具不得覆盖内置 `save_field` / `mark_complete`，冲突即启动报错
- [ ] 5.3 handler 异常隔离：单个工具抛错 → tool_result 返回错误文本，不中断对话循环
- [ ] 5.4 `views/summary.html` 整页替换机制：存在即替代默认 dashboard 用户列表页，
      注入数据 `{ activity, fields, users }`
- [ ] 5.5 做一个示例活动（`activities/example-with-tools/`）演示自定义工具 + 自定义结果页，作为活文档
- [ ] 5.6 skills 更新：`new-activity` 访谈中加一问「是否需要自定义工具/页面」，需要则生成骨架

**验收**：示例活动的自定义工具在真实对话中被模型正确调用；自定义结果页正常渲染。

---

## 持续事项（不属于任何 Phase）

- [ ] 每个 Phase 合并前：真实扫码 + 真实对话回归一次（`npm run relogin` 换新会话测首扫路径）
- [ ] 跑过 2–3 场真实活动后：把打磨好的 pack 沉淀进 `new-activity` SKILL.md 作为 few-shot 范例（架构文档 §11）
- [ ] 观察 DeepSeek 的 save_field 误用率，积累数据决定 Phase 3.3 校验策略是否需要调整
- [ ] SDK 上游问题跟踪：`loginCallbacks` 构造参数被忽略、session 过期重登不转发 callbacks——
      若 `@wechatbot/wechatbot` 发新版，检查是否已修复，已修复则简化 `core/channel/wechat.js`

## 里程碑定义

- **M1（Phase 1–3 完成）**：换活动 = 只写 pack 文件，src/ 零改动 —— 这是「可复用 core」成立的判据
- **M2（Phase 4–5 完成）**：`zlink run` 一键起活动 + 逃生舱可用 —— 架构文档 §3 完全落地
- M2 之后再评估：多活动路由、云端部署等（架构文档 §10 的不做清单到期重审）
