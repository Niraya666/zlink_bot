---
name: edit-activity
description: 修改已有活动 pack 的配置。当用户想调整某场活动的字段、语气、开场白、收尾行为等时使用。
---

# 修改活动 pack

## 流程

1. **定位 pack**：列出 `activities/` 下的目录；用户没指明哪场活动且存在多个时，先问。
   若 `activities/` 不存在或为空，但 `config/questions.json` 存在，说明还是纯 v1 配置——
   建议先用 new-activity skill 把它升级成 pack，或直接改 `config/questions.json`（按用户意愿）。

2. **展示现状**：读取 pack 三个文件，用一张摘要表展示当前配置（字段、语气、开关、话术），
   让用户确认要改哪里。

3. **应用修改**，注意约束：
   - 字段 key 保持 snake_case；改动 `type` 限 `string` / `boolean`
   - **重命名字段 key 时警告**：`profile_fields` 表里已按旧 key 存储的数据不会自动迁移，
     已有报名数据的活动改 key 会导致旧数据在 dashboard 上消失。问清楚是真要改名，
     还是只改 `label`（展示名，可随意改）
   - 删除必收字段前确认——会改变「收齐即完成」的判定
   - flow.md 正文的引导策略修改后，保持 frontmatter 与 activity.json 的一致性
     （`close_when_complete` 只在 activity.json，`opening`/`tone` 只在 flow.md，不要两处重复）

4. **v1 兼容桥**：若 `src/conversation.js` 仍读 `config/questions.json` 且该活动是当前
   运行的活动，按 new-activity skill §4 的映射表重新同步一次。

5. **收尾**：摘要展示改动前后差异；改动涉及引导策略时建议跑一次 test-activity。
