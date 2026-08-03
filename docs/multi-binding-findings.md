# 多绑定可行性调研：已验证 / 待验证

> 状态：调研中（2026-07-29）
> 起因：v2 架构假设「一个 bot 服务多个参与者」，但实际接入模型与该假设冲突。
> 结论未定前**不要**动 v3 架构代码。

## 1. 问题从哪来

原设计（`docs/architecture-v2.md`）默认：运营者扫码一次让 bot 上线，随后多个参与者
给这个「机器人微信号」发消息。**这个前提是错的。**

iLink（微信 ClawBot / OpenClaw 接入协议）的实际模型是：

> "Generate a QR code and scan it with WeChat. **A new contact named ClawBot appears in your WeChat.**"
> —— allclaw.org/blog/what-is-ilink

机器人身份是**扫码那一刻在扫码者的微信里创建的**，不存在一个预先可加好友的号。因此：

- ❌ 不能「把 bot 微信号的好友二维码发给参与者」——没有这样的号
- ❌ 不能拉群 / 转发名片让别人接入（已确认微信侧不具备该能力）
- ✅ 每个参与者必须**各自扫一个属于自己的二维码**才能建立会话

同一份文档还写明当前定位：

> "This is a **one-to-one setup model rather than a shared bot**."
> "currently focused on personal use and private chats (**not yet a fully open third-party Bot platform**)"

即：官方把它定位为一对一个人助手，尚未开放为第三方 Bot 平台。这是本调研的根本风险来源。

## 2. 二维码有效期（已实测，三次一致）

| 项 | 值 | 来源 |
|---|---|---|
| 单张二维码有效期 | **约 120 秒** | 实测三次：120s 时 `wait` → 122s 时 `expired` |
| `MAX_QR_REFRESH_COUNT` | 3 | SDK 常量，过期自动换新最多 3 张 |
| **总登录窗口** | **约 6 分钟** | 两者相乘，超时抛 `AuthError` 须重启进程 |

**接口响应里没有任何 TTL 字段**（`QrCodeResponse` 只有 `qrcode` 与 `qrcode_img_content`），
有效期完全由服务端控制，代码里读不到——上表是实测值。

### 顺带查明：状态接口是长轮询

`get_qrcode_status` **单次请求会挂起约 45–48 秒**才返回，不是即时查询。

- SDK 的 `QR_POLL_INTERVAL_MS = 2000` 只是间隔，真实轮询频率由服务端挂起时间决定
- 写观测脚本时若按 2 秒一轮，会看到大量「超时」，那是正常行为不是网络故障
- 早期一次 TTL 观测因此中间大段缺采样点，误判为网络问题

## 3. 已验证 ✅

### 3.1 服务端接受并发签发多个独立会话

同一台机器**同时**请求两个二维码，返回两个不同 token，无拒绝、无频率限制报错：

```
A=18f338a3aea23c8ec3a852b1b2b7b5ae
B=ee87f22ad110d1f26b839e1a4161bc9a
两个 token 不同: true
```

关键点：`local_token_list` 必须传空数组。若带上已有凭证的 token，服务端会用
`binded_redirect` 复用现有绑定而非签发新会话。

### 3.2 并发会话生命周期各自独立，互不顶掉

全程同时轮询两者，行为完全同步且独立：

```
  + 49s  A=挂起超时(48s)   B=挂起超时(48s)
  + 97s  A=挂起超时(48s)   B=挂起超时(48s)
  +122s  A=expired(25s)   B=expired(25s)
```

没有出现任何「一方存活导致另一方立即失效」的现象。

### 3.3 SDK 层凭证完全隔离

`storageDir` 按实例生效（`resolveStorage()` → `new FileStorage(options.storageDir)`），
两个 `WeChatBot` 可在同一进程共存：

```
凭证互不覆盖:  A=AAA B=BBB → true
游标互不覆盖:  A=1  B=2   → true
各自独立落盘:  bindA=[credentials.json,cursor.json]  bindB=[...]
真实登录态未变: true
两实例可共存:   true
```

SDK 内**无模块级单例状态**，多实例没有代码层障碍。

> 以上测试均使用独立临时 `storageDir`，实测确认未触碰 `~/.wechatbot/`。

### 3.4 复现脚本

已验证项的脚本留在仓库里，换机器/隔一段时间可直接重跑：

```bash
node scripts/probe-storage-isolation.mjs     # §3.3，秒级，无网络
node scripts/probe-concurrent-sessions.mjs   # §3.1 + §3.2，约 2 分钟（长轮询）
```

两者都不需要扫码，也不会碰 `~/.wechatbot/`。

待验证项的脚本见 §4：`scripts/probe-dual-binding.mjs`（需要两个微信号）。

## 4. 双绑定验证 —— ✅ 已通过（2026-08-03）

用 `scripts/probe-dual-binding.mjs` 实测，两个真实微信号各自扫码绑定：

```
绑定 A   成功于 14:37:16   收到 5 条   uid=o9cq802K5oKe-y1fFY4nxuqVwlRY@im.wechat   异常 0
绑定 B   成功于 14:37:36   收到 7 条   uid=o9cq8079f0YE5sKySPImzRjfwJ80@im.wechat   异常 0
```

| 问题 | 结果 |
|---|---|
| **Q1 两个绑定能否共存** | ✅ 全程无 `session:expired`，B 接入未顶掉 A |
| **Q2 消息路由是否正确** | ✅ 两边 `userId` 完全不重叠，无串台 |
| **Q3 并发上限** | ⏳ 仅测到 2，见下方 §4.2 |

**结论：「一台服务器为多个参与者各自维持独立绑定」在协议层面成立**，
v3 的 session-per-participant 架构（§5）可以往下做。

### 4.1 同一微信号只能持有一个有效绑定 ⚠️

验证过程中发现的副作用，**比 Q1/Q2 本身更需要注意**：

绑定 A 用的是主号，而该号此前已有一个绑定存于 `~/.wechatbot/`。
探针重新扫码建立新绑定后，正式 bot 再启动即报：

```
WARN  notifyStart failed (ignored): session timeout
WARN  [poller] Session expired — emitting session:expired
INFO  [auth] Cleared all stored credentials and state
```

即：**同一微信号再次扫码，会顶掉它自己之前的绑定**（不同账号之间则可共存）。

对 300 人场景本身无害（每人一个账号、各持一个绑定），但对 v3 有两个具体影响：

1. **参与者重复扫码是必然会发生的**（页面刷新、之前没聊完又回来）。
   服务端会让他的旧绑定失效 ⇒ v3 必须监听该 session 的 `session:expired`，
   **回收对应的僵尸 WeChatBot 实例与长轮询**，否则连接数会随重复扫码单调增长。
2. **运营者不能用同一个微信号既跑正式 bot 又当测试参与者** —— 会互相顶掉。
   测试要用独立小号。

> 副作用提示：本次验证已导致 `~/.wechatbot/` 被清空，正式 bot 需重新扫码
> （`zlink run <slug>` 会自动出码）。

### 4.2 Q3 并发上限 —— 仍待验证

2 个能过不代表 300 个能过，这是**当前最大的未知**。官方定位仍是
"个人助手、尚未开放为第三方 Bot 平台"，限流最可能在规模上出现。

做法：把 `scripts/probe-dual-binding.mjs` 里的 `records` 从 2 个标签扩到
5 / 10 / 20，逐步逼近真实规模，观察从第几个开始出现限流或绑定失效。

注意扩到 5 个以上时，靠人工扫码已不现实（每张码只有 120 秒）。
届时更实际的做法是**只签发不确认**——批量请求二维码但不扫，
先测「服务端允许同时存在多少个待确认会话」，这个上限往往就是绑定数上限的先行指标。

### 怎么测（约二十分钟，借一台手机即可）

脚本已备好，借到第二个微信号直接跑：

```bash
node scripts/probe-dual-binding.mjs
```

它会做这些事：

1. 用 `data/probe-bindings/{a,b}` 两个独立 `storageDir` 建两个 `WeChatBot`
   （**不碰 `~/.wechatbot/` 的正式登录态**，已实测确认）
2. 先出绑定 A 的二维码（**直接在终端渲染成图**，不是只打链接），扫完立即开始长轮询
3. 再出绑定 B 的二维码 —— **此时紧盯 A 会不会冒出 `session:expired`，这是 Q1 的关键信号**
4. 两个号各发一条消息，脚本会回一条带 `[A]` / `[B]` 标签的消息
   —— 手机上收到的标签对不对，直接暴露有没有串台
5. `Ctrl-C` 退出时打印汇总，自动判定 Q1 / Q2，并清理临时目录

参数：`--keep` 保留凭证目录（下次运行复用、跳过扫码，可用于测"重启后两个绑定是否都还在"）。

不调用 LLM，因此**不需要 `.env` / API key**。

若中途报 `The operation was aborted due to timeout`：`get_qrcode_status` 单次会挂起
约 45 秒（见 §2），网络抖一下就会抛。脚本会照常汇总，直接重跑一次即可。

### Q3 怎么继续往上加

Q1 / Q2 通过后，把脚本里的 `records` 从 2 个标签扩到 5、10、20，
逐步逼近真实规模（300 人），观察从第几个开始出现限流或绑定失效。

## 5. 若验证通过，架构要怎么改

好消息：改动集中在 **channel 层**，`core/engine/`（prompt / tools / conversation）与
`core/store/` 基本不动，activity pack 机制原样保留——这正是 Phase 1–5 把活动语义
与 core 拆开的收益。

```
参与者打开报名页（公网可达）
        ↓ 每次访问 = 一个 session
  新建 WeChatBot 实例，storageDir = data/sessions/<id>/
        ↓ login({ callbacks: { onQrUrl } })
  拿到专属二维码 → 推给该访客的页面（120 秒内有效）
        ↓ 参与者扫码
  ClawBot 出现在他微信里 → bot.start() 开始长轮询
        ↓
  进入现有对话流程（engine 层完全复用）
```

新增的复杂度（现在完全没有的东西）：

- **会话生命周期**：出了码没人扫、扫了不聊、聊完要不要停——都需要状态管理与清理
- **重复扫码回收**（§4.1 实测得出，容易漏）：同一微信号再次扫码会顶掉自己的旧绑定，
  必须监听 `session:expired` 回收僵尸实例与长轮询，否则连接数随重复扫码单调增长
- **资源**：每个绑定一条独立长轮询（`getupdates` 40s 超时）。50 人 = 50 条并发连接，
  Mac mini 扛得住；数百人需要重新评估
- **前端**：页面要处理 120 秒过期与自动换码（最多 3 张），超时后引导重新开始

## 6. 公网暴露：远程报名场景基本避不开

> 本节是初步分析。**具体方案与执行顺序已单独成文：`docs/public-exposure-plan.md`**
> （含 300 人场景下的抉择表、小程序为何被排除、三步走计划）。

二维码 120 秒过期 + 每人需要独立的码 ⇒ 码必须在参与者点开的那一刻现场生成，
生成动作在你的机器上 ⇒ 中间必须有从参与者设备到你机器的可达路径。

但「公网暴露」是光谱，不等于「自有域名 + ICP 备案 + 暴露主机」：

| 方案 | 需要备案 | 上手成本 | 主要风险 |
|---|---|---|---|
| 隧道（Cloudflare Tunnel / frp） | 否 | 几十分钟 | 用服务商域名；国内访问稳定性不可控，正式活动有风险 |
| 云主机 + 域名 + 备案 | 是 | 数周（备案周期） | 正规但前置时间长，需把服务迁出 Mac mini |
| 借道微信生态（公众号 / 小程序） | 需各自认证 | 数天 | 仍需后端出码，等于上面两者之一再加一层 |

隧道方案下机器仍是**出站连接**、无需开入站端口，与现有架构一致，适合原型阶段验证。

### 两类可以完全不碰公网的场景

1. **线下扫屏** —— 现场签到时摆一台设备/投屏，每来一人现场刷新一张码。
   参与者只用摄像头，不访问你的服务，120 秒完全够用。
2. **小规模手动私发** —— 二维码内容本质是 URL
   （`https://liteapp.weixin.qq.com/q/7GiQu1?qrcode=<每人不同>&bot_type=3`），
   在微信里点链接与扫码等效。十几人可手动私发，再多不现实。

两者都要求「你和参与者已有其他触达渠道」。若本来就有活动群，值得反问这个 bot
到底解决了什么问题。

## 7. 顺手记下的技术债

- `core/store/db.js` 的 `context_tokens` 表**从未被调用**（`saveContextToken` /
  `getContextToken` 无任何调用方）。context token 由 SDK 在自己的 storage 里管理。
  改架构时可删除，避免误导。

## 8. 决策点 —— 已决（2026-08-03）

```
§4 双绑定验证  ✅ 通过
        ↓
按 §5 改造 channel 层（session-per-participant）
按 §6 / public-exposure-plan.md 选公网方案（原型先用隧道）
        ↓
剩余最大未知：§4.2 并发上限（2 ≠ 300）
```

原本的两条否定分支（退化为个人助手 / 改用公众号等通道 / 退回网页表单）**暂不需要**，
但若 §4.2 在小规模就撞限流，它们仍是备选。

公网方案的执行顺序见 `docs/public-exposure-plan.md` §8。
