import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseURL: process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com/anthropic",
});

const MODEL = process.env.DEEPSEEK_MODEL || "deepseek-chat";

/**
 * Build the tool definitions for an activity.
 *
 * `field` is an enum of the activity's own keys, so the schema itself steers the
 * model away from inventing field names. conversation.js validates again on the
 * way in — the enum is guidance, not a guarantee.
 */
export function buildTools(activity) {
  const keys = activity.fields.map((f) => f.key);
  const descriptions = activity.fields
    .map((f) => `${f.key}=${f.label}${f.type === "boolean" ? "（true/false）" : ""}`)
    .join("，");

  return [
    {
      name: "save_field",
      description:
        "记录用户提供的一条信息。当用户在对话中提到了可记录的信息时立即调用此工具。",
      input_schema: {
        type: "object",
        properties: {
          field: {
            type: "string",
            enum: keys,
            description: `字段名，必须是以下之一：${descriptions}`,
          },
          value: {
            type: "string",
            description:
              "字段值。布尔类型的字段只能填 true 或 false，不要填原话。",
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
}

/**
 * Call Claude/DeeSeek API.
 * Returns content blocks so the caller can handle tool use loops.
 */
export async function callClaude(systemPrompt, messages, tools) {
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: systemPrompt,
    messages,
    tools,
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
