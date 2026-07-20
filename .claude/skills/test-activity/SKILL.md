---
name: test-activity
description: 上线前模拟测试一场活动的对话流程。当用户想检验某个活动 pack 的引导效果、字段收集是否顺畅时使用，在对话中扮演报名助手与用户走完整流程。
---

# 模拟测试活动对话

不启动真实机器人、不调 DeepSeek API，直接在 Claude Code 对话里角色扮演，
检验 pack 的引导策略是否能自然地收齐字段。

## 流程

### 1. 组装 system prompt

按运行时的方式拼出报名助手会拿到的完整 prompt：

最省事的办法是直接调渲染器拿到真实 prompt：

```bash
node -e "
import('./core/activity.js').then(async a=>{
  const p=await import('./core/engine/prompt.js');
  console.log(p.renderSystemPrompt(a.loadActivity('<slug>'), {}));
})"
```

（`{}` 是已收集字段，测试从空开始。）

### 2. 角色扮演

明确告诉用户测试开始，然后**严格按组装出的 prompt 扮演报名助手**：

- 用 prompt 里的开场白开场
- 用户扮演参与者回复
- 每轮回复后，用引用块标注本轮的「工具调用」：
  > 🔧 save_field(name, "张三")
- 布尔字段必须记 `true` / `false`（不是原话）；用 `fields.json` 里没有的 key
  会被运行时拒绝，模拟时也要照此判定
- 遵守 prompt 的规则：每轮只问 1–2 个问题、语气一致、收齐后收尾

用户随时可以说「暂停」跳出角色讨论问题，说「继续」回到扮演。
也可以要求「自动测试」——由你同时扮演参与者（分别测试配合型 / 敷衍型 / 跑题型三种画风），
快速走完三轮完整对话。

### 3. 测试报告

对话结束（或用户喊停）后，跳出角色输出报告：

- **字段覆盖**：必收字段是否全部收到；第几轮收齐
- **引导质量**：问题是否自然融入对话、有没有连珠炮式提问、语气是否符合 tone
- **边界行为**：用户跑题/敷衍时是否能拉回；收齐后是否按 `close_when_complete` 正确收尾
- **改进建议**：具体到 flow.md 该改哪句、fields.json 该调哪个字段；
  用户认可后可直接代改（等同于执行 edit-activity）

## 注意

- 模拟用的是当前 Claude 模型，真实运行时是 DeepSeek——引导效果可能有差异，
  报告里提醒这一点：模拟主要检验 prompt 设计本身，不是模型表现
- 不要真的写数据库、不要启动 `npm start`
