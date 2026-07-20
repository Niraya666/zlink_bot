import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseURL: process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com/anthropic",
});

const MODEL = process.env.DEEPSEEK_MODEL || "deepseek-chat";

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
