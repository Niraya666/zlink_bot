# 运行手册：在 Mac mini 上跑一场真实报名

> 适用：15–20 人规模的小范围测试（本周计划）
> 前置结论见 `multi-binding-findings.md`（多绑定可行）与 `public-exposure-plan.md`（先隧道不上云）

## 0. 一分钟看懂架构

```
参与者（微信）
    ↓ 打开群里发的固定链接
公网域名 ──Cloudflare Tunnel──> Mac mini :3001  参与者页面（对外）
                                Mac mini :3000  运营者控制台（绝不对外）
    ↓ 每个访客当场拿到属于自己的二维码
    ↓ 扫码 → ClawBot 出现在他的微信里 → 开始对话
```

**一个参与者 = 一个独立绑定 = 一条独立长轮询。** 链接是静态的，二维码是每人独立的。

## 1. 开跑前的检查

```bash
cd ~/project/zlink/zlink_bot
node cli.js list          # 确认活动配置无误（显示 ● 而不是 ✗）
```

- `.env` 里 `DEEPSEEK_API_KEY` 已设置（对话要用）
- `activities/` 下若有多个活动，命令里必须带 slug
  （想省掉这个参数就删掉不用的：`rm -rf activities/example-with-tools`）

**微信号的坑**：同一个微信号同时只能持有一个绑定，再次扫码会顶掉之前的
（连带顶掉绑在别处的 OpenClaw 之类）。所以**别用你日常在跑其他 bot 的号来测**。

## 2. 起服务（关键：防休眠）

```bash
caffeinate -dimsu node --env-file=.env cli.js serve demo-day-2026
```

`caffeinate -dimsu` 必须加——Mac 一休眠，隧道和所有长轮询全断，
参与者那边直接失联。这是无人值守时最容易踩的坑。

启动后会看到：

```
✓ 参与者页面已启动: http://localhost:3001  ← 隧道指向这个端口
✓ 网页控制台已启动: http://localhost:3000
```

> ⚠️ **控制台（3000）绝对不能暴露**。它无鉴权，`/api/users` 会漏出全部报名数据。
> 隧道只指向 3001。

## 3. 开隧道

### 3.1 快速验证用（URL 每次重启都变，只适合自己测）

```bash
cloudflared tunnel --url http://localhost:3001
```

### 3.2 真实测试用：named tunnel + 自有域名

**发到群里的链接必须稳定**——quick tunnel 一重启 URL 就变，链接当场作废。

前置：域名已托管在 Cloudflare（NS 指向 CF）。

```bash
cloudflared tunnel login                              # 浏览器授权域名
cloudflared tunnel create zlink                       # 创建隧道
cloudflared tunnel route dns zlink join.你的域名.com    # 绑定子域名
cloudflared tunnel run --url http://localhost:3001 zlink
```

之后固定访问 `https://join.你的域名.com`。

自有域名同时降低被微信拦截的风险——`*.trycloudflare.com` 是多人共用的公共域名，
被他人滥用会连累你（实测微信目前放行，但这是动态判定，不保证）。

## 4. 发到群里之前，自己先走一遍

用**另一个微信号**完整走一遍：打开链接 → 扫码 → 聊完 → 确认控制台里出现这条记录。

确认无误后再把链接发群里。附一句引导语效果更好，例如：

> 报名请点这个链接，扫码后小助手会在微信里和你聊两句完成登记 👉 https://join.你的域名.com

## 5. 测试期间盯什么

**终端日志**——每轮对话会打印耗时：

```
[对话] o9cq8079f0YE… 用时 2.1s（LLM 1.8s ×2轮, 发送 0.3s）
[对话] o9cq802K5oK… 用时 24.3s（LLM 23.9s ×4轮, 发送 0.4s）  ⚠ 偏慢
[会话] 共 12  bound=9 pending=2 failed=1
```

- 超过 10 秒会标 `⚠ 偏慢`，括号里能看出卡在 LLM、工具循环还是微信发送
- `failed` 是二维码超时没人扫（正常，有人点开又走了）

**控制台** `http://localhost:3000`：实时看报名名单与字段采集情况。

## 6. 结束后

```bash
node cli.js export demo-day-2026 --csv > signups.csv   # 导出数据
```

`Ctrl-C` 停服务（会自动清理所有会话凭证目录），再停掉 cloudflared。

## 7. 已知行为，不是 bug

| 现象 | 说明 |
|---|---|
| 二维码约两分钟变一次 | 服务端 TTL 约 120 秒，页面自动换新，最多 3 次（约 6 分钟） |
| 参与者页面显示"二维码已超时" | 6 分钟内没扫完，点「重新开始」即可 |
| 参与者重复扫码 | 旧绑定被顶掉是正常的，服务端会回收僵尸实例 |
| 同一微信号在别处重连 | 会顶掉这边的绑定，参与者需重新扫 |
| 国内访问偏慢 | Cloudflare 免费版无中国节点，流量绕境外（本次不优化） |

## 8. 出问题时

**参与者页面一直转圈** → 看终端有没有报错；`curl -X POST localhost:3001/api/session` 手测建会话。

**扫码后没反应** → 看日志有没有 `✓ 已绑定`。没有说明确认环节没走完，让他重扫。

**机器人不回复** → 看 `[对话]` 日志。没有这行说明消息没收到（长轮询问题）；
有这行但很慢，看括号里的分解。

**全员失联** → 先确认 Mac 没休眠、cloudflared 还活着。这两个是最常见原因。

## 9. 这次测试要验证什么

代码链路已经端到端跑通过（单人真机验证），所以这次的重点是**规模与真实用户行为**：

1. **并发绑定数** —— 15–20 个同时在线，会不会撞 iLink 限流（`multi-binding-findings.md` §4.2 的未知项）
2. **微信是否放行自有域名** —— 真实流量、被转进群之后的表现
3. **对话质量** —— 引导策略在真人身上的效果、`save_field` 的误用率
4. **那两次异常延迟** —— 之前出现过 22s / 74s 但未能复现，这次有耗时日志可定位

跑完把终端日志和 `signups.csv` 留着，用于复盘。
