import { getDb } from "./db";
import { COMPANION_TIMEZONE, formatDate } from "./time";

// Her own record of her free time (life.ts): diary entries, plus a log of
// messages she sent unprompted (kind "message", detail = QQ number).

const DAY_MS = 24 * 3600 * 1000;

export function addJournal(companion: string, kind: string, content: string, detail?: string) {
  getDb()
    .prepare(`INSERT INTO journal (companion, kind, content, detail, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run(companion, kind, content, detail ?? null, Date.now());
}

export type JournalEntry = { kind: string; content: string; detail: string | null; created_at: number };

export function recentJournal(companion: string, kind: string, sinceMs: number, limit = 10): JournalEntry[] {
  return getDb()
    .prepare(
      `SELECT kind, content, detail, created_at FROM journal
       WHERE companion = ? AND kind = ? AND created_at >= ?
       ORDER BY id DESC LIMIT ?`
    )
    .all(companion, kind, Date.now() - sinceMs, limit)
    .reverse() as JournalEntry[];
}

// Diary entries run to hundreds of characters; whole entries in every chat
// prompt crowded out the conversation and set her mood for it.
const DIARY_ENTRIES = 2;
const DIARY_CHARS = 150;

/** Diary lines for the chat prompt: what she's been up to lately. */
export function recentDiary(companion: string): string[] {
  return recentJournal(companion, "diary", 2 * DAY_MS, DIARY_ENTRIES).map((e) => {
    // She often starts an entry with its own date; we add ours.
    const text = e.content.replace(/^\s*\d{4}[/-]\d{1,2}[/-]\d{1,2}[：:]\s*/, "").replace(/\s+/g, " ");
    const short = text.length > DIARY_CHARS ? text.slice(0, DIARY_CHARS) + "…" : text;
    return `${formatDate(e.created_at, COMPANION_TIMEZONE)}：${short}`;
  });
}
