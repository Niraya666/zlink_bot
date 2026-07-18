import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import path from "node:path";
import fs from "node:fs";

const DATA_DIR = path.resolve("data");
const DB_PATH = path.join(DATA_DIR, "bot.sqlite");

export function initDatabase() {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  // Uses Node's built-in SQLite (node:sqlite, available from Node 22.5+),
  // so there is no native module to compile. DatabaseSync's prepare/run/get/all
  // API is API-compatible with the subset of better-sqlite3 used below.
  const db = new DatabaseSync(DB_PATH);

  // node:sqlite has no .pragma() helper — use exec() with PRAGMA statements.
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id            TEXT PRIMARY KEY,
      wechat_uid    TEXT UNIQUE NOT NULL,
      status        TEXT NOT NULL DEFAULT 'bound',
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
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

    CREATE TABLE IF NOT EXISTS context_tokens (
      wechat_uid    TEXT PRIMARY KEY,
      token         TEXT NOT NULL,
      updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  return {
    getOrCreateUser(wechatUid) {
      let user = db
        .prepare("SELECT * FROM users WHERE wechat_uid = ?")
        .get(wechatUid);
      if (!user) {
        const id = randomUUID();
        db.prepare("INSERT INTO users (id, wechat_uid) VALUES (?, ?)").run(
          id,
          wechatUid,
        );
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

    getUserSummaries() {
      return db
        .prepare(
          `SELECT u.wechat_uid, u.status, u.created_at,
                  MAX(CASE WHEN pf.field = 'name' THEN pf.value END) as name,
                  MAX(CASE WHEN pf.field = 'wechat_contact' THEN pf.value END) as wechat_contact,
                  MAX(CASE WHEN pf.field = 'intent_confirmed' THEN pf.value END) as intent_confirmed
           FROM users u
           LEFT JOIN profile_fields pf ON pf.user_id = u.id
           GROUP BY u.id
           ORDER BY u.created_at DESC`,
        )
        .all();
    },
  };
}
