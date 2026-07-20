import fs from "node:fs";
import path from "node:path";

const CONFIG_PATH = path.resolve("config/questions.json");

/**
 * Load and normalize the activity config.
 *
 * Phase 1 still reads config/questions.json. In Phase 2 this is replaced by the
 * activity pack loader (activities/<slug>/), and the shape returned here is the
 * target shape: event metadata + a field schema with labels.
 */
export function loadActivityConfig() {
  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));

  // ACTIVITY env var wins so several activities can share one checkout.
  const eventId = process.env.ACTIVITY || raw.event_id || "default";

  return {
    ...raw,
    eventId,
    eventName: raw.event_name || eventId,
    fields: normalizeFields(raw),
  };
}

/**
 * Build the field schema the dashboard renders columns from.
 * Precursor to fields.json — `field_labels` maps directly to `label` there.
 */
function normalizeFields(raw) {
  const labels = raw.field_labels || {};
  return (raw.required_fields || []).map((key) => ({
    key,
    label: labels[key] || key,
  }));
}
