# iLink Bot 原型

基于 iLink Bot API + DeepSeek 的微信机器人，实现多轮对话完成用户画像采集。

## 快速开始

### 1. 环境要求

- Node.js >= 22.5（数据库使用内置的 `node:sqlite`，无需原生编译）
- 一个微信机器人账号（通过 iLink 协议接入）

### 2. 安装

```bash
git clone git@github.com:Niraya666/zlink_bot.git
cd zlink_bot
npm install
```

### 3. 配置

编辑 `.env` 文件，填入 DeepSeek API Key：

```bash
cp .env.example .env   # 如果没有 .env 的话
```

```env
DEEPSEEK_API_KEY=sk-your-key-here
DEEPSEEK_BASE_URL=https://api.deepseek.com/anthropic
DEEPSEEK_MODEL=deepseek-chat
```

对话行为由 `config/questions.json` 控制：

```json
{
  "opening": "开场白",
  "required_fields": ["name", "wechat_contact", "intent_confirmed"],
  "key_questions": ["问题1", "问题2"],
  "tone": "轻松、口语化",
  "close_when_complete": true
}
```

- `required_fields` — 必收字段，全部收齐后自动结束对话
- `close_when_complete` — 设为 `true` 时，收齐后不再继续提问

### 4. 运行

```bash
npm start
```

首次运行会打印二维码链接，用微信扫码绑定机器人。之后任何人给这个微信号发消息，都会进入对话流程。

## 项目结构

```
src/
├── index.js           # 入口：登录 → 长轮询循环
├── ilink-client.js    # iLink SDK 封装（QR 登录、消息收发）
├── conversation.js    # 对话处理：拼 system prompt → 调 LLM → 处理 tool calls
├── llm.js             # DeepSeek API 封装（Anthropic 兼容模式）+ tool 定义
└── db.js              # SQLite 初始化 + CRUD（node:sqlite）
config/
└── questions.json     # 问题清单配置
data/
└── bot.sqlite         # 运行时自动创建
```

## 对话流程

1. 用户发消息 → iLink 长轮询收到
2. 查 SQLite 获取用户历史 + 已采集画像
3. 拼 system prompt（问题清单 + 已采集字段 + 缺失字段）
4. 调 DeepSeek API（带 tool use）
5. 模型决定记录哪些字段 (`save_profile_field`) 或结束对话 (`mark_complete`)
6. 回复用户，保存消息到数据库

## 技术栈

| 层 | 选型 |
|---|---|
| 运行时 | Node.js ≥ 22.5 |
| 微信接入 | @wechatbot/wechatbot SDK |
| LLM | DeepSeek（Anthropic Messages API 兼容端点） |
| 数据库 | SQLite（Node 内置 `node:sqlite`，无需原生编译） |
