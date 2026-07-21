import { pathToFileURL } from "node:url";

// Built-in tool names an activity's tools.js must not shadow — overriding these
// would silently break field capture / completion.
const RESERVED = new Set(["save_field", "mark_complete"]);

/**
 * Load an activity's optional custom tools (activities/<slug>/tools.js).
 *
 * Returns `[]` when the pack has none. Throws on a malformed tools.js so the
 * problem surfaces at startup (run.js awaits this once) rather than mid-chat.
 * Each entry is `{ definition, handler }`: `definition` goes to the LLM as a
 * tool spec, `handler(input, ctx)` runs when the model calls it.
 */
export async function loadCustomTools(activity) {
  if (!activity.toolsPath) return [];

  const mod = await import(pathToFileURL(activity.toolsPath).href);
  const tools = mod.tools ?? mod.default;

  if (!Array.isArray(tools)) {
    throw new Error(
      `活动配置有误 — ${activity.slug}/tools.js\n` +
        "  ✗ 需要 `export const tools = [...]`（或 default 导出一个数组）",
    );
  }

  const errors = [];
  const seen = new Set();

  tools.forEach((t, i) => {
    const at = `tools[${i}]`;
    if (!t || typeof t.name !== "string" || !t.name) {
      errors.push(`${at}.name 缺失或不是字符串`);
      return;
    }
    if (RESERVED.has(t.name)) {
      errors.push(`${at}.name "${t.name}" 是内置工具名，不能覆盖`);
    }
    if (seen.has(t.name)) {
      errors.push(`${at}.name "${t.name}" 与前面的自定义工具重名`);
    }
    seen.add(t.name);
    if (typeof t.description !== "string" || !t.description) {
      errors.push(`${at}（${t.name}）缺少 description`);
    }
    if (t.input_schema === undefined || typeof t.input_schema !== "object") {
      errors.push(`${at}（${t.name}）缺少 input_schema 对象`);
    }
    if (typeof t.handler !== "function") {
      errors.push(`${at}（${t.name}）缺少 handler 函数`);
    }
  });

  if (errors.length > 0) {
    throw new Error(
      `活动配置有误 — ${activity.slug}/tools.js\n` +
        errors.map((e) => `  ✗ ${e}`).join("\n"),
    );
  }

  return tools.map((t) => ({
    definition: {
      name: t.name,
      description: t.description,
      input_schema: t.input_schema,
    },
    handler: t.handler,
  }));
}
