import path from "node:path";
import { fileURLToPath } from "node:url";

// Resolved from this file's location, not process.cwd(), so the CLI finds the
// same activities/ and data/ no matter which directory it's invoked from.
export const PROJECT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

export const ACTIVITIES_DIR = path.join(PROJECT_ROOT, "activities");
export const DATA_DIR = path.join(PROJECT_ROOT, "data");
export const DB_PATH = path.join(DATA_DIR, "bot.sqlite");
