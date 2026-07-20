import { buildTools } from "./llm.js";
import { loadActivity, normalizeFieldValue } from "./activity.js";
import { renderSystemPrompt } from "./prompt.js";

const MAX_TOOL_ITERATIONS = 5;

/**
 * Apply one tool call and return the text handed back to the model as its
 * tool_result. Rejections are phrased so the model can fix them and retry —
 * a wrong field name is answered with the list of valid ones.
 */
function applyToolCall(call, { db, user, activity }) {
  if (call.name === "mark_complete") {
    db.updateUserStatus(user.id, "completed");
    return { completed: true, result: "对话已标记为完成" };
  }

  if (call.name !== "save_field") {
    return { result: `未知工具 ${call.name}` };
  }

  const key = call.input?.field;
  const field = activity.fields.find((f) => f.key === key);
  if (!field) {
    const valid = activity.fields.map((f) => f.key).join("、");
    return {
      result: `没有名为「${key}」的字段，未记录。可用字段：${valid}`,
    };
  }

  const normalized = normalizeFieldValue(field, call.input?.value);
  if (!normalized.ok) {
    return { result: `未记录：${normalized.reason}` };
  }

  db.saveProfileField(user.id, field.key, normalized.value);
  return { result: `已记录 ${field.key}: ${normalized.value}` };
}

export function createConversationHandler(db, callClaude) {
  return async function handleMessage(msg, replyFn) {
    const wechatUid = msg.userId;
    const text = msg.text;

    const user = db.getOrCreateUser(wechatUid);

    // Reloaded per message so pack edits take effect without a restart.
    const activity = loadActivity();

    // Skip if user already completed or dropped
    if (user.status === "completed" || user.status === "dropped") {
      await replyFn(activity.reentryMessage);
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
        await replyFn(activity.completionMessage);
        return;
      }
    }

    const systemPrompt = renderSystemPrompt(activity, collected);
    const tools = buildTools(activity);

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
        const response = await callClaude(
          systemPrompt,
          conversationMessages,
          tools,
        );

        // Apply each call and keep its outcome — the model is told what
        // actually happened, including rejections, so it can correct itself.
        const outcomes = response.toolCalls.map((call) => ({
          call,
          ...applyToolCall(call, { db, user, activity }),
        }));

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

          // If mark_complete was called, stop iterating
          if (outcomes.some((o) => o.completed)) {
            responseText = response.text || "感谢你的参与，信息已收集完毕！";
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
      await replyFn("抱歉，我暂时有点卡壳，稍等一下再试试～");
      return;
    }

    db.saveMessage(user.id, "assistant", responseText);
    await replyFn(responseText);
  };
}
