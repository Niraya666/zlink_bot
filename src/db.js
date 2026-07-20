import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import path from "node:path";
import fs from "node:fs";

const DATA_DIR = path.resolve("data");
const DB_PATH = path.join(DATA_DIR, "bot.sqlite");

/**
 * A pre-v2 database has a `users` table without `event_id`. SQLite can't add
 * the new (event_id, wechat_uid) uniqueness in place, and the prototype has no
 * migration story (see docs/architecture-v2.md §6), so the old file is set
 * aside and a fresh one is built. The backup keeps the old data recoverable.
 */
function isLegacySchema(dbPath) {
  if (!fs.existsSync(dbPath)) return false;

  const probe = new DatabaseSync(dbPath);
  try {
    const columns = probe.prepare("PRAGMA table_info(users)").all();
    if (columns.length === 0) return false; // no users table yet — nothing stale
    return !columns.some((c) => c.name === "event_id");
  } finally {
    probe.close();
  }
}

function backupLegacyDatabase(dbPath) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = `${dbPath}.bak-${stamp}`;

  // Move the WAL sidecars too, or SQLite would replay them into the new db.
  for (const suffix of ["", "-wal", "-shm"]) {
    const source = dbPath + suffix;
    if (fs.existsSync(source)) fs.renameSync(source, backupPath + suffix);
  }
  return backupPath;
}

/**
 * Open the database, scoped to a single activity.
 *
 * Every returned method operates within `eventId` — callers never pass it, so
 * one activity cannot read or write another's data.
 */
export function initDatabase({ eventId, eventName } = {}) {
  if (!eventId) throw new Error("initDatabase 需要 eventId");

  fs.mkdirSync(DATA_DIR, { recursive: true });

  if (isLegacySchema(DB_PATH)) {
    const backupPath = backupLegacyDatabase(DB_PATH);
    console.log("⚠ 检测到 v1 数据库结构（缺少 event_id），已备份为：");
    console.log(`  ${backupPath}`);
    console.log("  将创建全新数据库。");
  }

  // Uses Node's built-in SQLite (node:sqlite, available from Node 22.5+),
  // so there is no native module to compile. DatabaseSync's prepare/run/get/all
  // API is API-compatible with the subset of better-sqlite3 used below.
  const db = new DatabaseSync(DB_PATH);

  // node:sqlite has no .pragma() helper — use exec() with PRAGMA statements.
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS users (
      id            TEXT PRIMARY KEY,
      event_id      TEXT NOT NULL REFERENCES events(id),
      wechat_uid    TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'bound',
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (event_id, wechat_uid)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id       TEXT NOT NULL REFERENCES users(id),
      role          TEXT NOT NULL,
      content       TEXT NOT NULL,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS profile_fields (
      user_id       TEXT NOT NULL REFERENCES users(id),
      field         TEXT NOT NULL,
      value         TEXT NOT NULL,
      updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, field)
    );

    -- context_tokens belong to the WeChat session layer, not to an activity,
    -- so they stay keyed by wechat_uid alone (docs/architecture-v2.md §6).
    CREATE TABLE IF NOT EXISTS context_tokens (
      wechat_uid    TEXT PRIMARY KEY,
      token         TEXT NOT NULL,
      updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  db.prepare(
    `INSERT INTO events (id, name) VALUES (?, ?)
     ON CONFLICT (id) DO UPDATE SET name = excluded.name`,
  ).run(eventId, eventName || eventId);

  return {
    eventId,

    getOrCreateUser(wechatUid) {
      let user = db
        .prepare("SELECT * FROM users WHERE event_id = ? AND wechat_uid = ?")
        .get(eventId, wechatUid);
      if (!user) {
        const id = randomUUID();
        db.prepare(
          "INSERT INTO users (id, event_id, wechat_uid) VALUES (?, ?, ?)",
        ).run(id, eventId, wechatUid);
        user = db.prepare("SELECT * FROM users WHERE id = ?").get(id);
      }
      return user;
    },

    saveMessage(userId, role, content) {
      return db
        .prepare(
          "INSERT INTO messages (user_id, role, content) VALUES (?, ?, ?)",
        )
        .run(userId, role, content);
    },

    getRecentMessages(userId, limit = 20) {
      return db
        .prepare(
          "SELECT role, content FROM messages WHERE user_id = ? ORDER BY id DESC LIMIT ?",
        )
        .all(userId, limit)
        .reverse();
    },

    saveProfileField(userId, field, value) {
      return db
        .prepare(
          `INSERT INTO profile_fields (user_id, field, value, updated_at)
           VALUES (?, ?, ?, datetime('now'))
           ON CONFLICT (user_id, field) DO UPDATE SET
             value = excluded.value,
             updated_at = datetime('now')`,
        )
        .run(userId, field, value);
    },

    getProfileFields(userId) {
      const rows = db
        .prepare("SELECT field, value FROM profile_fields WHERE user_id = ?")
        .all(userId);
      return Object.fromEntries(rows.map((r) => [r.field, r.value]));
    },

    updateUserStatus(userId, status) {
      return db
        .prepare("UPDATE users SET status = ? WHERE id = ?")
        .run(status, userId);
    },

    saveContextToken(wechatUid, token) {
      return db
        .prepare(
          `INSERT INTO context_tokens (wechat_uid, token, updated_at)
           VALUES (?, ?, datetime('now'))
           ON CONFLICT (wechat_uid) DO UPDATE SET
             token = excluded.token,
             updated_at = datetime('now')`,
        )
        .run(wechatUid, token);
    },

    getContextToken(wechatUid) {
      const row = db
        .prepare("SELECT token FROM context_tokens WHERE wechat_uid = ?")
        .get(wechatUid);
      return row?.token ?? null;
    },

    /**
     * All users of this activity, each with every profile field collected so far.
     *
     * Deliberately field-agnostic: no field name appears in the SQL, so adding
     * or renaming a field never requires touching this query. Deciding which
     * fields to display is the dashboard's job.
     */
    getUserSummaries() {
      const users = db
        .prepare(
          `SELECT id, wechat_uid, status, created_at
           FROM users WHERE event_id = ?
           ORDER BY created_at DESC`,
        )
        .all(eventId);

      const rows = db
        .prepare(
          `SELECT pf.user_id, pf.field, pf.value
           FROM profile_fields pf
           JOIN users u ON u.id = pf.user_id
           WHERE u.event_id = ?`,
        )
        .all(eventId);

      const collectedByUser = new Map();
      for (const row of rows) {
        if (!collectedByUser.has(row.user_id)) {
          collectedByUser.set(row.user_id, {});
        }
        collectedByUser.get(row.user_id)[row.field] = row.value;
      }

      return users.map((u) => ({
        wechat_uid: u.wechat_uid,
        status: u.status,
        created_at: u.created_at,
        collected: collectedByUser.get(u.id) || {},
      }));
    },
  };
}
