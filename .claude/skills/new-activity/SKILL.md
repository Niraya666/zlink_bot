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

### 4. 校验

用加载器确认 pack 合法——它会一次性列出所有问题，每条指明文件和字段：

```bash
node -e "import('./src/activity.js').then(m=>{m.loadActivity('<slug>');console.log('OK')})"
```

按报错逐条修，直到输出 OK。

### 5. 收尾

- 打印生成的文件清单和内容摘要（字段表 + 开场白 + 关键开关）
- 若 `activities/` 下已不止一个活动，提醒用户启动时要指定：`ACTIVITY=<slug> npm start`
- 建议用户接下来用 test-activity skill 模拟一遍对话，检验引导效果
