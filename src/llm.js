import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseURL: process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com/anthropic",
});

const MODEL = process.env.DEEPSEEK_MODEL || "deepseek-chat";

export const TOOLS = [
  {
    name: "save_profile_field",
    description:
      "记录用户提供的一条画像信息。当用户在对话中提到了可记录的信息时调用此工具。",
    input_schema: {
      type: "object",
      properties: {
        field: {
          type: "string",
          description: "字段名，如 name、wechat_contact、intent_confirmed 等",
        },
        value: {
          type: "string",
          description: "字段值，即用户提供的信息内容",
        },
      },
      required: ["field", "value"],
    },
  },
  {
    name: "mark_complete",
    description:
      "标记当前用户的对话已完成。仅在所有必收字段都已收集完毕后调用。调用后，本轮回复应当自然收尾，不再继续提问。",
    input_schema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
];

/**
 * Call Claude/DeeSeek API.
 * Returns content blocks so the caller can handle tool use loops.
 */
export async function callClaude(systemPrompt, messages) {
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: systemPrompt,
    messages,
    tools: TOOLS,
    tool_choice: { type: "auto" },
  });

  const textParts = [];
  const toolCalls = [];

  for (const block of response.content) {
    if (block.type === "text") {
      textParts.push(block.text);
    } else if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id,
        name: block.name,
        input: block.input,
      });
    }
  }

  return {
    text: textParts.join(""),
    toolCalls,
    stopReason: response.stop_reason,
    content: response.content,
  };
}
