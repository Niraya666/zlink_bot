# v2 开发计划清单

> 状态：进行中（2026-07-20 制定）
> 依据：`docs/architecture-v2.md`（尤其 §9 迁移路径）
> 原则：每个 Phase 独立可用、独立提交；任何时刻 `main` 都能跑通完整扫码登录 + 对话流程。

## 总览

| Phase | 内容 | 状态 | 依赖 |
|---|---|---|---|
| 0 | Claude Code skills（配置活动） | ✅ 已完成（7549e75） | 无 |
| 1 | 数据层：event_id + schema 驱动 | ✅ 已完成 | 无 |
| 2 | Activity pack：目录结构 + 加载校验 | ✅ 已完成 | Phase 1 |
| 3 | Prompt 渲染：flow.md 接管对话策略 | ✅ 已完成（**M1 达成**） | Phase 2 |
| 4 | 目录重排 core/ + CLI | ✅ 已完成 | Phase 3 |
| 5 | 逃生舱：tools.js + views/ | ✅ 已完成（**M2 达成**） | Phase 4 |

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

- [x] 2.1 创建第一个 pack `activities/demo-day-2026/`（activity.json + fields.json + flow.md）
- [x] 2.2 实现 pack 加载器 `src/activity.js`：frontmatter 用极简 `key: value` 解析器，不引依赖
- [x] 2.3 加载校验：缺文件 / JSON 非法 / key 非 snake_case / key 重复 / type 越界 /
      slug 与目录名不符 / 无必收字段 / frontmatter 缺失 —— **一次性列出全部问题**，
      每条指明文件与字段；`index.js` 顶层捕获，只印消息不印堆栈
- [x] 2.4 `conversation.js` / `index.js` / `server.js` 全部改从 activity 对象取配置；
      重入话术与完成话术从 `activity.json` 读取（原硬编码已清除）
- [x] 2.5 活动选择：`ACTIVITY` 环境变量；单 pack 时可省略，多个未指定则报错并列出候选与示例命令
- [x] 2.6 删除 `config/questions.json` 与 `src/config.js`；同步拆除三个 skill 里的 v1 兼容桥，
      改为「写完调加载器校验」；架构文档 §8、README、CLAUDE.md 一并更新
- [x] 2.7 按 `new-activity` SKILL.md 模板构造 pack 验证兼容性（含可选字段、starts_at、自定义话术）

**验收**：✅ 已验证。对话行为不变（prompt 断言 7 项全过，收尾/重入话术改由 pack 驱动）；
故意写坏 pack 得到可读报错；真实 `npm start` 全链路通过。

**遗留**：`fields.json` 的 `type` 目前只是声明性元数据，`intent_confirmed` 标为 boolean
但实际存的仍是模型写入的自由文本——归一化在 Phase 3.4 落地。

---

## Phase 3 — Prompt 渲染：flow.md 接管对话策略

**目标**：`buildSystemPrompt` 里的活动叙事移入 flow.md，core 只追加运行时段落。

- [x] 3.1 渲染器 `src/prompt.js`：flow.md 正文原样作主体，字段 schema、已收集/缺失、
      语气、工具规则由 core 统一追加（活动写不了这些，因此不会与执行逻辑脱节）
- [x] 3.2 `conversation.js` 删除 `buildSystemPrompt`，改调 `renderSystemPrompt`
- [x] 3.3 `save_profile_field` → `save_field`；工具定义改由 `buildTools(activity)` 动态生成，
      `field` 带 key 枚举做第一道约束，`applyToolCall` 落库前二次校验，
      未知 key 拒绝并把可用清单作为 tool_result 回传
- [x] 3.4 `normalizeFieldValue`：boolean 归一化（精确匹配优先，否定前缀优先于肯定，
      故「不会来」不会被「会」误判）；歧义值拒绝并要求模型重判；string 去空白、空值拒绝
- [x] 3.5 回归：完整采集→自动收尾→重入全流程通过；boolean 正确归一化落库；
      未知字段与歧义值均未污染数据库

**验收**：✅ 已验证。用一个叙事/字段/语气完全不同的活动（读书会）渲染 prompt，`src/` 零改动即生效；
`close_when_complete: false` 时 mark_complete 规则正确消失；schema 外字段被拒绝。

**遗留**：真实 DeepSeek 的自纠率尚未在线上验证（本阶段用脚本化 LLM 覆盖了拒绝路径）。
跑通首场真实活动后观察，若纠错率低再考虑宽松模式。

---

## Phase 4 — 目录重排 core/ + CLI

**目标**：物理结构对齐架构文档 §3，入口变为 CLI。

- [x] 4.1 目录迁移全部用 `git mv`，9 个文件的历史均保留（git 识别为 rename）。
      两个已修过的坑在搬家中完整保留：loginCallbacks 只在 run()/login() 生效的注释、
      session_expired 不翻 waiting_qr 的处理
- [x] 4.2 `cli.js`：`run` / `list` / `export` / `relogin` / `help`；
      `list` 对配置有误的 pack 优雅降级（打印错误后继续列其余活动）；
      export 支持 JSON 与 CSV，CSV 正确转义逗号与内嵌引号
- [x] 4.3 `relogin` 并入 CLI；`core/channel/session.js` 由脚本改为导出
      `hasSavedLogin()` / `clearSavedLogin()`，无登录态时幂等提示
- [x] 4.4 `package.json` 注册 `bin.zlink`；`npm start` 改为 `node cli.js run`
- [x] 4.5 `web_port` 进 `activity.json`（校验 1–65535）；
      优先级 `WEB_PORT` 环境变量 > `web_port` > 3000
- [x] 4.6（追加）新增 `core/paths.js`：路径从模块位置解析而非 cwd，
      CLI 从任意目录调用都能找到 activities/ 与 data/
- [x] 4.7 文档同步：README、CLAUDE.md、架构文档 §4.1，以及三个 skill 里的路径与校验命令

**验收**：✅ 已验证。`npm start` 与 `node cli.js run <slug>` 均完整跑通（登录 + 控制台）；
`web_port: 3100` 实测生效；CSV 转义正确；从 `/tmp` 调用 CLI 行为一致；
多活动未指定时报错并给出可复制的命令。

---

## Phase 5 — 逃生舱：tools.js + views/

**目标**：给「配置覆盖不了的 20%」留出口。

- [x] 5.1 `core/engine/custom-tools.js`：启动时一次性 import pack 的 `tools.js`
      （代码而非 config，不逐消息重载）；协议 `{ name, description, input_schema, handler(input, ctx) }`，
      ctx = `{ db, user, activity }`（db 已按 event_id 作用域化）
- [x] 5.2 名字冲突保护：不得覆盖 `save_field` / `mark_complete`，重名/坏结构一次性列出并启动报错
- [x] 5.3 handler 异常隔离：抛错 → 错误文本作为 tool_result 回传，对话循环不中断
- [x] 5.4 `views/summary.html` 整页替换 `/`：在 `<head>` 后注入
      `window.__ZLINK__ = { eventName, fields }`，`/api/*` 端点照常可用
- [x] 5.5 示例活动 `activities/example-with-tools/`：`check_seat_availability` 自定义工具
      + 名额概览自定义结果页，作为活文档
- [x] 5.6 `new-activity` skill 加「§3b 逃生舱」一问，需要才生成骨架，指向示例活动
- [x] 5.7（追加）修掉 latent bug：对话处理器逐消息重载改为按 slug 重载，
      不再 `resolveActivitySlug()`——否则一旦有第 2 个活动，运行中的机器人每条消息都会报歧义

**验收**：✅ 已验证。自定义工具端到端被模型调用并回传结果；handler 抛错被隔离对话继续；
自定义结果页浏览器实测渲染（名额从 `/api/users` 实时计算、卡片列表、状态徽章）；
冲突/坏结构启动报错。

---

## 持续事项（不属于任何 Phase）

- [ ] 每个 Phase 合并前：真实扫码 + 真实对话回归一次（`npm run relogin` 换新会话测首扫路径）
- [ ] 跑过 2–3 场真实活动后：把打磨好的 pack 沉淀进 `new-activity` SKILL.md 作为 few-shot 范例（架构文档 §11）
- [ ] 观察 DeepSeek 的 save_field 误用率，积累数据决定 Phase 3.3 校验策略是否需要调整
- [ ] SDK 上游问题跟踪：`loginCallbacks` 构造参数被忽略、session 过期重登不转发 callbacks——
      若 `@wechatbot/wechatbot` 发新版，检查是否已修复，已修复则简化 `core/channel/wechat.js`

## 里程碑定义

- **M1（Phase 1–3 完成）**：✅ **已达成**（2026-07-20）。换活动 = 只写 pack 文件，src/ 零改动
  —— 已用读书会 pack（叙事/字段/语气/开关全不同）验证
- **M2（Phase 4–5 完成）**：✅ **已达成**（2026-07-21）。`zlink run` 一键起活动 + 逃生舱可用
  —— 架构文档 §3 完全落地
- M2 之后再评估：多活动路由、云端部署等（架构文档 §10 的不做清单到期重审）
