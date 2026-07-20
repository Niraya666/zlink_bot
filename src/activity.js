import fs from "node:fs";
import path from "node:path";

const ACTIVITIES_DIR = path.resolve("activities");
const FIELD_KEY_RE = /^[a-z][a-z0-9_]*$/;
const FIELD_TYPES = ["string", "boolean"];

/**
 * Pick which activity pack to run.
 *
 * ACTIVITY env var wins; otherwise a lone pack is used implicitly. With several
 * packs and no ACTIVITY we refuse rather than guess — picking the wrong one
 * would write real signups into the wrong event.
 */
export function resolveActivitySlug() {
  if (!fs.existsSync(ACTIVITIES_DIR)) {
    throw new Error(
      `找不到 activities/ 目录（期望位置：${ACTIVITIES_DIR}）。\n` +
        "用 new-activity skill 创建一个活动，或手工建 activities/<slug>/。",
    );
  }

  const slugs = fs
    .readdirSync(ACTIVITIES_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => e.name);

  const requested = process.env.ACTIVITY;
  if (requested) {
    if (!slugs.includes(requested)) {
      throw new Error(
        `ACTIVITY=${requested} 对应的活动不存在。\n` +
          `已有活动：${slugs.length ? slugs.join("、") : "（无）"}`,
      );
    }
    return requested;
  }

  if (slugs.length === 0) {
    throw new Error(
      "activities/ 下没有活动。用 new-activity skill 创建一个。",
    );
  }
  if (slugs.length > 1) {
    throw new Error(
      `activities/ 下有多个活动，请用环境变量指定要跑哪个：\n` +
        slugs.map((s) => `  ACTIVITY=${s} npm start`).join("\n"),
    );
  }
  return slugs[0];
}

/**
 * Load and validate an activity pack.
 *
 * All problems found are reported at once — fixing config one error per restart
 * is miserable. Every message names the offending file and field.
 */
export function loadActivity(slug = resolveActivitySlug()) {
  const dir = path.join(ACTIVITIES_DIR, slug);
  const errors = [];

  const activityJson = readJson(path.join(dir, "activity.json"), errors);
  const fieldsJson = readJson(path.join(dir, "fields.json"), errors);
  const flowRaw = readText(path.join(dir, "flow.md"), errors);

  // Without the files there is nothing left to validate.
  if (errors.length > 0) throw packError(slug, errors);

  validateActivityJson(activityJson, slug, errors);
  const fields = validateFields(fieldsJson, errors);
  const flow = parseFlow(flowRaw, errors);

  if (errors.length > 0) throw packError(slug, errors);

  return {
    slug,
    dir,
    name: activityJson.name,
    startsAt: activityJson.starts_at ?? null,
    closeWhenComplete: activityJson.close_when_complete !== false,
    reentryMessage:
      activityJson.reentry_message ??
      "你之前已经完成过对话啦，如有疑问请联系活动组织者～",
    completionMessage:
      activityJson.completion_message ??
      "好啦，你的信息我都记下了！感谢配合，如有变动随时联系我～",
    fields,
    requiredFields: fields.filter((f) => f.required).map((f) => f.key),
    flow,
  };
}

// ── file readers ─────────────────────────────────────────────────────

function readJson(file, errors) {
  const name = path.basename(file);
  if (!fs.existsSync(file)) {
    errors.push(`缺少 ${name}`);
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch (err) {
    errors.push(`${name} 不是合法 JSON：${err.message}`);
    return null;
  }
}

function readText(file, errors) {
  const name = path.basename(file);
  if (!fs.existsSync(file)) {
    errors.push(`缺少 ${name}`);
    return null;
  }
  return fs.readFileSync(file, "utf-8");
}

// ── validators ───────────────────────────────────────────────────────

function validateActivityJson(json, slug, errors) {
  if (typeof json.name !== "string" || !json.name.trim()) {
    errors.push("activity.json: `name` 必填，且为非空字符串");
  }
  if (json.slug !== undefined && json.slug !== slug) {
    errors.push(
      `activity.json: \`slug\` 为 "${json.slug}"，与目录名 "${slug}" 不一致`,
    );
  }
  if (
    json.close_when_complete !== undefined &&
    typeof json.close_when_complete !== "boolean"
  ) {
    errors.push("activity.json: `close_when_complete` 必须是 true / false");
  }
  for (const key of ["reentry_message", "completion_message"]) {
    if (json[key] !== undefined && typeof json[key] !== "string") {
      errors.push(`activity.json: \`${key}\` 必须是字符串`);
    }
  }
}

function validateFields(json, errors) {
  if (!Array.isArray(json.fields) || json.fields.length === 0) {
    errors.push("fields.json: `fields` 必须是非空数组");
    return [];
  }

  const seen = new Set();
  const fields = [];

  json.fields.forEach((f, i) => {
    const at = `fields.json: fields[${i}]`;

    if (typeof f.key !== "string" || !FIELD_KEY_RE.test(f.key)) {
      errors.push(
        `${at}.key "${f.key}" 不合法——需为 snake_case（小写字母开头，只含小写字母/数字/下划线）`,
      );
      return;
    }
    if (seen.has(f.key)) {
      errors.push(`${at}.key "${f.key}" 重复`);
      return;
    }
    seen.add(f.key);

    if (f.type !== undefined && !FIELD_TYPES.includes(f.type)) {
      errors.push(
        `${at}.type "${f.type}" 不支持——只能是 ${FIELD_TYPES.join(" / ")}`,
      );
    }
    if (f.label !== undefined && typeof f.label !== "string") {
      errors.push(`${at}.label 必须是字符串`);
    }
    if (f.required !== undefined && typeof f.required !== "boolean") {
      errors.push(`${at}.required 必须是 true / false`);
    }

    fields.push({
      key: f.key,
      label: typeof f.label === "string" && f.label ? f.label : f.key,
      type: f.type ?? "string",
      required: f.required !== false,
    });
  });

  if (fields.length > 0 && !fields.some((f) => f.required)) {
    errors.push("fields.json: 至少要有一个 `required: true` 的字段");
  }

  return fields;
}

/**
 * Parse flow.md into frontmatter + body.
 *
 * Deliberately a tiny `key: value` reader rather than a YAML dependency —
 * the frontmatter holds a handful of flat strings and nothing more.
 */
function parseFlow(raw, errors) {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    errors.push("flow.md: 缺少 --- 包裹的 frontmatter");
    return { tone: "", strictness: "lenient", opening: "", body: raw.trim() };
  }

  const [, frontmatterRaw, body] = match;
  const meta = {};

  frontmatterRaw.split(/\r?\n/).forEach((line, i) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;

    const sep = trimmed.indexOf(":");
    if (sep === -1) {
      errors.push(`flow.md: frontmatter 第 ${i + 1} 行不是 "key: value" 格式`);
      return;
    }
    const key = trimmed.slice(0, sep).trim();
    const value = trimmed
      .slice(sep + 1)
      .trim()
      .replace(/^["'](.*)["']$/, "$1");
    meta[key] = value;
  });

  if (!meta.opening) errors.push("flow.md: frontmatter 缺少 `opening`（开场白）");
  if (!meta.tone) errors.push("flow.md: frontmatter 缺少 `tone`（语气）");
  if (!body.trim()) errors.push("flow.md: 正文为空——正文是给助手的引导策略");

  return {
    tone: meta.tone || "",
    strictness: meta.strictness || "lenient",
    opening: meta.opening || "",
    body: body.trim(),
  };
}

function packError(slug, errors) {
  return new Error(
    `活动配置有误 — activities/${slug}/\n` +
      errors.map((e) => `  ✗ ${e}`).join("\n"),
  );
}
