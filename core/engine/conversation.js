import { buildTools } from "./tools.js";
import { loadActivity, normalizeFieldValue } from "../activity.js";
import { renderSystemPrompt } from "./prompt.js";

const MAX_TOOL_ITERATIONS = 5;

/**
 * Apply one tool call and return the text handed back to the model as its
 * tool_result. Rejections are phrased so the model can fix them and retry —
 * a wrong field name is answered with the list of valid ones.
 *
 * @param customTools Map<name, handler> — an activity's tools.js handlers.
 */
async function applyToolCall(call, ctx, customTools) {
  const { db, user, activity } = ctx;

  if (call.name === "mark_complete") {
    db.updateUserStatus(user.id, "completed");
    return { completed: true, result: "对话已标记为完成" };
  }

  if (call.name === "save_field") {
    const key = call.input?.field;
    const field = activity.fields.find((f) => f.key === key);
    if (!field) {
      const valid = activity.fields.map((f) => f.key).join("、");
      return { result: `没有名为「${key}」的字段，未记录。可用字段：${valid}` };
    }

    const normalized = normalizeFieldValue(field, call.input?.value);
    if (!normalized.ok) {
      return { result: `未记录：${normalized.reason}` };
    }

    db.saveProfileField(user.id, field.key, normalized.value);
    return { result: `已记录 ${field.key}: ${normalized.value}` };
  }

  // Custom tool from the pack's tools.js. A handler throwing must not kill the
  // conversation — the error goes back as the tool_result so the model can
  // react, and the loop continues.
  const handler = customTools.get(call.name);
  if (handler) {
    try {
      const result = await handler(call.input ?? {}, ctx);
      return { result: result == null ? "（无返回）" : String(result) };
    } catch (err) {
      console.error(`自定义工具 ${call.name} 执行失败:`, err.message);
      return { result: `工具 ${call.name} 执行出错：${err.message}` };
    }
  }

  return { result: `未知工具 ${call.name}` };
}

/**
 * @param options.slug        which pack to reload each message. Required so a
 *                             multi-activity checkout reloads THIS activity
 *                             rather than re-resolving (which would be ambiguous).
 * @param options.customTools  loaded once at startup by loadCustomTools().
 */
export function createConversationHandler(db, callClaude, options = {}) {
  const { slug, customTools = [] } = options;
  // name -> handler, and static definitions merged into every request.
  const handlerByName = new Map(customTools.map((t) => [t.definition.name, t.handler]));
  const customDefs = customTools.map((t) => t.definition);

  // 同一用户的消息必须排队串行处理。参与者等不及时几乎必然会补发一条，
  // 并发处理会让回复乱序——实测出现过「先收到收尾语、16 秒后才收到上一句的回应」。
  const queues = new Map();

  /**
   * @param replyFn  发送回复
   * @param typingFn 可选，(on:boolean) => void，用于显示/取消「正在输入」
   */
  return function handleMessage(msg, replyFn, typingFn) {
    const key = msg.userId;
    const prev = queues.get(key) ?? Promise.resolve();

    // 前一条即使失败也不能断链，否则该用户后续消息全部卡死
    const next = prev
      .catch(() => {})
      .then(() => processMessage(msg, replyFn, typingFn));

    queues.set(key, next);
    next.catch(() => {}).finally(() => {
      if (queues.get(key) === next) queues.delete(key); // 只有队尾才清理
    });
    return next;
  };

  async function processMessage(msg, replyFn, typingFn) {
    const wechatUid = msg.userId;
    const text = msg.text;
    const startedAt = Date.now();
    const timing = { llmMs: 0, rounds: 0, sendMs: 0 };

    // 微信的「正在输入」会自己消失，长回合要周期性续上，
    // 否则用户以为没反应就会补发消息。
    let typingTimer = null;
    let typingOn = false;

    // typingFn 返回 Promise，同步 try/catch 接不住它的 rejection。
    // 这里是 fire-and-forget（setInterval 里没人 await），未捕获的 rejection
    // 会直接杀掉整个进程——真实活动中就意味着一个人的网络抖动让所有人的
    // 会话一起断。必须把 Promise 也吞掉。
    const safeTyping = (on) => {
      if (!typingFn) return;
      try {
        const r = typingFn(on);
        if (r && typeof r.then === "function") {
          r.catch(() => {}); // 输入提示失败无关紧要，绝不能影响对话
        }
      } catch {
        // 同步抛错同理
      }
    };

    const startTyping = () => {
      if (!typingFn || typingOn) return;
      typingOn = true;
      safeTyping(true);
      typingTimer = setInterval(() => safeTyping(true), 8000);
      typingTimer.unref?.();
    };
    // 幂等：send() 与 finally 都会调，别重复向微信发取消请求
    const stopTyping = () => {
      if (typingTimer) clearInterval(typingTimer);
      typingTimer = null;
      if (!typingOn) return;
      typingOn = false;
      safeTyping(false);
    };

    // 发送要自己重试：SDK 的重试策略只覆盖 AbortError / TimeoutError
    //（见 transport/http.js 的 isRetryable），连接类错误（ECONNRESET、
    // fetch failed）一次失败就直接抛。而消息在发送前已经落库了，
    // 发不出去就意味着"库里有、用户没收到"，对方只看到沉默。
    const send = async (content) => {
      stopTyping();
      const t = Date.now();
      let lastErr = null;

      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          await replyFn(content);
          lastErr = null;
          if (attempt > 1) timing.sendRetries = attempt - 1;
          break;
        } catch (err) {
          lastErr = err;
          if (attempt < 3) await new Promise((r) => setTimeout(r, 500 * attempt));
        }
      }

      timing.sendMs = Date.now() - t;

      // 三次都失败就不再抛了：抛出去只会让 SDK 打一行 Handler error，
      // 我们自己的耗时日志反而不会执行。这里打清楚，让复盘能查到。
      if (lastErr) {
        timing.sendFailed = true;
        console.error(
          `🔴 回复发送失败（已重试 3 次）给 ${wechatUid.slice(0, 12)}…：${lastErr.message}\n` +
            `   该条回复已存库但未送达，内容开头：${String(content).slice(0, 40)}`,
        );
      }
    };

    const report = (note = "") => {
      const total = Date.now() - startedAt;
      const sendPart =
        `发送 ${(timing.sendMs / 1000).toFixed(1)}s` +
        (timing.sendRetries ? `/重试${timing.sendRetries}次` : "") +
        (timing.sendFailed ? "/未送达🔴" : "");
      const detail =
        timing.rounds > 0
          ? `LLM ${(timing.llmMs / 1000).toFixed(1)}s ×${timing.rounds}轮, ${sendPart}`
          : `无需 LLM, ${sendPart}`;
      // 超过 10 秒标出来，方便回头定位慢在哪一段
      const slow = total > 10_000 ? "  ⚠ 偏慢" : "";
      console.log(
        `[对话] ${wechatUid.slice(0, 12)}… 用时 ${(total / 1000).toFixed(1)}s（${detail}）${note}${slow}`,
      );
    };

    const user = db.getOrCreateUser(wechatUid);

    // Reloaded per message so pack edits take effect without a restart.
    // Reload the SAME slug — don't re-resolve (ambiguous with 2+ activities).
    const activity = loadActivity(slug);

    // Skip if user already completed or dropped
    if (user.status === "completed" || user.status === "dropped") {
      await send(activity.reentryMessage);
      report(" [重入]");
      return;
    }

    db.saveMessage(user.id, "user", text);

    const history = db.getRecentMessages(user.id, 20);
    const collected = db.getProfileFields(user.id);

    // If close_when_complete is on and all required fields are collected,
    // auto-close without calling Claude
    if (activity.closeWhenComplete) {
      const missing = activity.requiredFields.filter((f) => !(f in collected));
      if (missing.length === 0) {
        db.updateUserStatus(user.id, "completed");
        db.saveMessage(user.id, "assistant", activity.completionMessage);
        await send(activity.completionMessage);
        report(" [自动收尾]");
        return;
      }
    }

    startTyping();

    const systemPrompt = renderSystemPrompt(activity, collected);
    const tools = [...buildTools(activity), ...customDefs];

    let responseText;
    try {
      // Build conversation history for Claude
      const conversationMessages = history.map((h) => ({
        role: h.role,
        content: h.content,
      }));

      // Tool use loop: keep calling Claude until it finishes (end_turn)
      // or we hit the iteration limit
      for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
        const t = Date.now();
        timing.rounds++; // 先计数：调用失败也算一轮，否则日志会写成「无需 LLM」
        const response = await callClaude(
          systemPrompt,
          conversationMessages,
          tools,
        );
        timing.llmMs += Date.now() - t;

        // Apply each call and keep its outcome — the model is told what
        // actually happened, including rejections, so it can correct itself.
        const ctx = { db, user, activity };
        const outcomes = [];
        for (const call of response.toolCalls) {
          outcomes.push({
            call,
            ...(await applyToolCall(call, ctx, handlerByName)),
          });
        }

        if (response.stopReason === "end_turn") {
          responseText = response.text;
          break;
        }

        if (response.stopReason === "tool_use") {
          // Append assistant's response (with tool_use blocks) to conversation
          conversationMessages.push({
            role: "assistant",
            content: response.content,
          });

          conversationMessages.push({
            role: "user",
            content: outcomes.map((o) => ({
              type: "tool_result",
              tool_use_id: o.call.id,
              content: o.result,
            })),
          });

          // If mark_complete was called, stop iterating.
          // 模型这一轮没生成文本时，用活动自己的收尾话术兜底——
          // 不能拿通用字符串糊弄过去，那会让参与者错过 pack 里精心写的
          // 收尾信息（名额、后续流程、注意事项）。
          if (outcomes.some((o) => o.completed)) {
            responseText = response.text || activity.completionMessage;
            break;
          }

          // Save preamble text in case next iteration doesn't return text
          responseText = response.text;
        }
      }

      // Fallback if loop ended without a final text
      if (!responseText) {
        responseText = "收到，我记下了～";
      }
    } catch (err) {
      console.error("Claude API error:", err.message);
      db.saveMessage(
        user.id,
        "assistant",
        "抱歉，我暂时有点卡壳，稍等一下再试试～",
      );
      await send("抱歉，我暂时有点卡壳，稍等一下再试试～");
      report(` [LLM 失败: ${err.message}]`);
      return;
    } finally {
      stopTyping(); // 无论成败都要收掉，别把「正在输入」永远挂着
    }

    db.saveMessage(user.id, "assistant", responseText);
    await send(responseText);
    report();
  }
}
