/**
 * Assemble the system prompt for an activity.
 *
 * The activity owns the narrative: flow.md's body goes in verbatim and can say
 * whatever the organizer wants. Everything appended below is runtime state and
 * mechanics that core must control — the field schema, what's already collected,
 * and the tool-calling rules. Activities never write those, so they can't drift
 * out of sync with the code that enforces them.
 */
export function renderSystemPrompt(activity, collected) {
  return [
    activity.flow.body,
    "",
    renderFieldSchema(activity),
    "",
    renderProgress(activity, collected),
    "",
    `语气要求：${activity.flow.tone}`,
    `严格程度：${activity.flow.strictness}`,
    "",
    renderRules(activity),
  ].join("\n");
}

function renderFieldSchema(activity) {
  const lines = activity.fields.map((f) => {
    const notes = [f.required ? "必收" : "可选"];
    if (f.type === "boolean") notes.push("布尔值，只能传 true 或 false");
    return `- ${f.key}（${f.label}；${notes.join("；")}）`;
  });

  return ["可记录的字段（调用 save_field 时 field 必须用下列 key 之一）：", ...lines].join(
    "\n",
  );
}

function renderProgress(activity, collected) {
  const entries = Object.entries(collected);
  const collectedStr =
    entries.length > 0
      ? entries.map(([k, v]) => `- ${k}: ${v}`).join("\n")
      : "（暂无）";

  const missing = activity.requiredFields.filter((f) => !(f in collected));
  const missingStr = missing.length > 0 ? missing.join("、") : "无，已全部收齐";

  return [
    "已经收集到的信息：",
    collectedStr,
    "",
    `还差以下必收字段：${missingStr}`,
  ].join("\n");
}

function renderRules(activity) {
  const rules = [
    "- 用户一旦提供了任何字段相关的信息，必须立即调用 save_field 工具记录，不要犹豫",
    "- 每轮只问 1-2 个问题，别一次甩一堆",
    "- 记录完信息后，自然地继续对话，追问尚未收集的字段",
  ];

  if (activity.closeWhenComplete) {
    rules.push(
      "- 必收字段全部收齐后，必须调用 mark_complete 工具，然后自然收尾，别继续硬聊",
    );
  }

  rules.push(`- 开场白：「${activity.flow.opening}」`);

  return ["规则：", ...rules].join("\n");
}
