import { TOOLS } from "./llm.js";
import { loadActivityConfig } from "./config.js";

const MAX_TOOL_ITERATIONS = 5;

export function buildSystemPrompt(config, collected) {
  const collectedStr =
    Object.keys(collected).length > 0
      ? Object.entries(collected)
          .map(([k, v]) => `- ${k}: ${v}`)
          .join("\n")
      : "（暂无）";

  const missingFields = config.required_fields.filter(
    (f) => !(f in collected),
  );
  const missingStr =
    missingFields.length > 0 ? missingFields.join("、") : "无，已全部收齐";

  const questionsStr = config.key_questions
    .map((q, i) => `${i + 1}. ${q}`)
    .join("\n");

  return `你是活动报名助手。你的任务是自然地聊天，同时完成三件事：
1. 传达活动的价值观方向，观察对方是否认同（不用打分，先记录印象）
2. 确认对方是否会来参加
3. 收集这些信息：${config.required_fields.join("、")}

已经收集到的信息：
${collectedStr}

还差以下必收字段：${missingStr}

问题清单（不用逐条照念，融进对话里问）：
${questionsStr}

语气要求：${config.tone}
严格程度：${config.strictness}

规则：
- 用户一旦提供了任何必收字段相关的信息，必须立即调用 save_profile_field 工具记录，不要犹豫
- 每轮只问 1-2 个问题，别一次甩一堆
- 记录完信息后，自然地继续对话，追问尚未收集的字段${config.close_when_complete ? "\n- 必收字段全部收齐后，必须调用 mark_complete 工具，然后自然收尾，别继续硬聊" : ""}
- 开场白：「${config.opening}」`;
}

export function createConversationHandler(db, callClaude) {
  return async function handleMessage(msg, replyFn) {
    const wechatUid = msg.userId;
    const text = msg.text;

    const user = db.getOrCreateUser(wechatUid);

    // Skip if user already completed or dropped
    if (user.status === "completed" || user.status === "dropped") {
      await replyFn(
        "你之前已经完成过对话啦，如有疑问请联系活动组织者～",
      );
      return;
    }

    db.saveMessage(user.id, "user", text);

    const history = db.getRecentMessages(user.id, 20);
    const collected = db.getProfileFields(user.id);
    // Reloaded per message so config edits take effect without a restart.
    const config = loadActivityConfig();

    // If close_when_complete is on and all required fields are collected,
    // auto-close without calling Claude
    if (config.close_when_complete) {
      const missing = config.required_fields.filter(
        (f) => !(f in collected),
      );
      if (missing.length === 0) {
        db.updateUserStatus(user.id, "completed");
        db.saveMessage(
          user.id,
          "assistant",
          "好啦，你的信息我都记下了！感谢配合，如有变动随时联系我～",
        );
        await replyFn(
          "好啦，你的信息我都记下了！感谢配合，如有变动随时联系我～",
        );
        return;
      }
    }

    const systemPrompt = buildSystemPrompt(config, collected);

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
