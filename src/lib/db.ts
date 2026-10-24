import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

// Single local SQLite file holds everything: chat history, long-term memories,
// relationship state and relationship events. No cloud services needed.
const DB_PATH = process.env.DB_PATH || "data/companion.db";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT    NOT NULL,
  companion   TEXT    NOT NULL,
  role        TEXT    NOT NULL CHECK (role IN ('user', 'assistant')),
  content     TEXT    NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_session
  ON messages (user_id, companion, id);

CREATE TABLE IF NOT EXISTS memories (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       TEXT    NOT NULL,
  companion     TEXT    NOT NULL,
  content       TEXT    NOT NULL,
  category      TEXT    NOT NULL DEFAULT 'other',
  tags          TEXT    NOT NULL DEFAULT '',   -- comma-separated keywords
  importance    REAL    NOT NULL DEFAULT 0.5,  -- 0..1
  created_at    INTEGER NOT NULL,
  last_used_at  INTEGER,
  use_count     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_memories_session
  ON memories (user_id, companion);

CREATE TABLE IF NOT EXISTS relationship_state (
  user_id      TEXT    NOT NULL,
  companion    TEXT    NOT NULL,
  closeness    INTEGER NOT NULL,
  trust        INTEGER NOT NULL,
  playfulness  INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (user_id, companion)
);

CREATE TABLE IF NOT EXISTS relationship_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT    NOT NULL,
  companion   TEXT    NOT NULL,
  event       TEXT    NOT NULL,
  emotion     TEXT,
  importance  REAL    NOT NULL DEFAULT 0.5,
  effect      TEXT    NOT NULL DEFAULT '{}',  -- JSON: {"trust": 2, ...}
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_session
  ON relationship_events (user_id, companion, created_at);

-- The companion's own growth, shared across everyone she talks to:
-- notes about herself picked up turn by turn, periodically folded into a
-- self-portrait. Old portraits are kept as a growth log.
CREATE TABLE IF NOT EXISTS self_notes (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  companion     TEXT    NOT NULL,
  content       TEXT    NOT NULL,
  created_at    INTEGER NOT NULL,
  consolidated  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_self_notes
  ON self_notes (companion, consolidated, id);

CREATE TABLE IF NOT EXISTS self_portraits (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  companion   TEXT    NOT NULL,
  text        TEXT    NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_self_portraits
  ON self_portraits (companion, id);

-- What she does on her own time (life.ts): diary entries, and a log of
-- messages she sent unprompted (kind = 'message', detail = QQ number).
CREATE TABLE IF NOT EXISTS journal (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  companion   TEXT    NOT NULL,
  kind        TEXT    NOT NULL,
  content     TEXT    NOT NULL,
  detail      TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_journal
  ON journal (companion, kind, created_at);
`;

// Next.js dev mode re-evaluates modules on every change; keep one connection.
const globalForDb = globalThis as unknown as { companionDb?: Database.Database };

export function getDb(): Database.Database {
  if (!globalForDb.companionDb) {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    const db = new Database(DB_PATH);
    db.pragma("journal_mode = WAL");
    db.exec(SCHEMA);
    globalForDb.companionDb = db;
  }
  return globalForDb.companionDb;
}
