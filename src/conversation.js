import { TOOLS } from "./llm.js";
import { loadActivity } from "./activity.js";

const MAX_TOOL_ITERATIONS = 5;

export function buildSystemPrompt(activity, collected) {
  const collectedStr =
    Object.keys(collected).length > 0
      ? Object.entries(collected)
          .map(([k, v]) => `- ${k}: ${v}`)
          .join("\n")
      : "（暂无）";

  const missingFields = activity.requiredFields.filter(
    (f) => !(f in collected),
  );
  const missingStr =
    missingFields.length > 0 ? missingFields.join("、") : "无，已全部收齐";

  // The activity's own guidance (flow.md body). Phase 3 makes this the whole
  // prompt body; for now it replaces the hardcoded narrative + question list.
  return `${activity.flow.body}

需要收集这些信息：${activity.requiredFields.join("、")}

已经收集到的信息：
${collectedStr}

还差以下必收字段：${missingStr}

语气要求：${activity.flow.tone}
严格程度：${activity.flow.strictness}

规则：
- 用户一旦提供了任何必收字段相关的信息，必须立即调用 save_profile_field 工具记录，不要犹豫
- 每轮只问 1-2 个问题，别一次甩一堆
- 记录完信息后，自然地继续对话，追问尚未收集的字段${activity.closeWhenComplete ? "\n- 必收字段全部收齐后，必须调用 mark_complete 工具，然后自然收尾，别继续硬聊" : ""}
- 开场白：「${activity.flow.opening}」`;
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

    const systemPrompt = buildSystemPrompt(activity, collected);

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
        const response = await callClaude(systemPrompt, conversationMessages);

        // Process any tool calls in this response
        for (const call of response.toolCalls) {
          if (call.name === "save_profile_field") {
            db.saveProfileField(user.id, call.input.field, call.input.value);
          }
          if (call.name === "mark_complete") {
            db.updateUserStatus(user.id, "completed");
          }
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

          // Build tool_result blocks and send back as a user message
          const toolResults = response.toolCalls.map((tc) => ({
            type: "tool_result",
            tool_use_id: tc.id,
            content: tc.name === "mark_complete"
              ? "对话已标记为完成"
              : `已记录 ${tc.input.field}: ${tc.input.value}`,
          }));
          conversationMessages.push({
            role: "user",
            content: toolResults,
          });

          // If mark_complete was called, stop iterating
          if (response.toolCalls.some((tc) => tc.name === "mark_complete")) {
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
