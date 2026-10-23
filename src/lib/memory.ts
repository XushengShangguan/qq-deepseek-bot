import { getDb } from "./db";
import type { ChatMessage } from "./llm";

// Short-term memory = recent rows of `messages`.
// Long-term memory  = rows of `memories`, retrieved by importance + simple
// keyword/tag matching (no embeddings in the MVP; see plan §7).

const RECENT_LIMIT = Number(process.env.RECENT_MESSAGES || 20);
const MEMORY_LIMIT = 8;

export type Session = { userId: string; companion: string };

export type Memory = {
  id: number;
  content: string;
  category: string;
  tags: string;
  importance: number;
  created_at: number;
};

export type NewMemory = {
  content: string;
  category?: string;
  tags?: string[];
  importance?: number;
};

// ---------- short-term ----------

export function saveMessage(
  { userId, companion }: Session,
  role: ChatMessage["role"],
  content: string
) {
  getDb()
    .prepare(
      `INSERT INTO messages (user_id, companion, role, content, created_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(userId, companion, role, content, Date.now());
}

export type TimedMessage = ChatMessage & { created_at: number };

export function getRecentMessages(
  { userId, companion }: Session,
  limit = RECENT_LIMIT
): TimedMessage[] {
  const rows = getDb()
    .prepare(
      `SELECT role, content, created_at FROM messages
       WHERE user_id = ? AND companion = ?
       ORDER BY id DESC LIMIT ?`
    )
    .all(userId, companion, limit) as TimedMessage[];
  rows.reverse();
  // Model APIs expect the conversation to open with a user turn.
  while (rows.length && rows[0].role !== "user") rows.shift();
  return rows;
}

export function countMessages({ userId, companion }: Session): number {
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS n FROM messages WHERE user_id = ? AND companion = ?`
    )
    .get(userId, companion) as { n: number };
  return row.n;
}

// ---------- long-term ----------

function clamp01(x: number) {
  return Math.max(0, Math.min(1, x));
}

export function addMemory(session: Session, m: NewMemory) {
  const db = getDb();
  const content = m.content.trim();
  if (!content) return;
  const importance = clamp01(m.importance ?? 0.5);

  // Same fact mentioned again -> reinforce instead of duplicating.
  const existing = db
    .prepare(
      `SELECT id, importance FROM memories
       WHERE user_id = ? AND companion = ? AND content = ?`
    )
    .get(session.userId, session.companion, content) as
    | { id: number; importance: number }
    | undefined;
  if (existing) {
    db.prepare(`UPDATE memories SET importance = ? WHERE id = ?`).run(
      clamp01(Math.max(existing.importance, importance) + 0.05),
      existing.id
    );
    return;
  }

  db.prepare(
    `INSERT INTO memories (user_id, companion, content, category, tags, importance, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    session.userId,
    session.companion,
    content,
    m.category || "other",
    (m.tags || []).map((t) => t.trim()).filter(Boolean).join(","),
    importance,
    Date.now()
  );
}

// Character bigrams work for Chinese without a tokenizer, and still catch
// English words reasonably well.
function bigrams(text: string): Set<string> {
  const s = text.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
  const out = new Set<string>();
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
  return out;
}

/**
 * MVP retrieval: score = importance + keyword/tag relevance to the new message.
 * Fine for hundreds of memories; switch to local embeddings when that stops
 * being enough (plan §7, "Later Upgrade").
 */
export function retrieveMemories(
  session: Session,
  text: string,
  limit = MEMORY_LIMIT
): Memory[] {
  const db = getDb();
  const all = db
    .prepare(
      `SELECT id, content, category, tags, importance, created_at FROM memories
       WHERE user_id = ? AND companion = ?`
    )
    .all(session.userId, session.companion) as Memory[];
  if (all.length === 0) return [];

  const query = bigrams(text);
  const scored = all.map((m) => {
    const tags = m.tags ? m.tags.split(",") : [];
    const tagHits = tags.filter((t) => t && text.includes(t)).length;
    const mb = bigrams(m.content + m.tags);
    let overlap = 0;
    query.forEach((g) => {
      if (mb.has(g)) overlap++;
    });
    const relevance = Math.min(1, tagHits * 0.5 + overlap / 6);
    return { m, score: m.importance + relevance };
  });
  scored.sort((a, b) => b.score - a.score);
  const picked = scored.slice(0, limit).map((s) => s.m);

  const touch = db.prepare(
    `UPDATE memories SET last_used_at = ?, use_count = use_count + 1 WHERE id = ?`
  );
  const now = Date.now();
  for (const m of picked) touch.run(now, m.id);
  return picked;
}

export function listMemories(session: Session): Memory[] {
  return getDb()
    .prepare(
      `SELECT id, content, category, tags, importance, created_at FROM memories
       WHERE user_id = ? AND companion = ? ORDER BY importance DESC, id DESC`
    )
    .all(session.userId, session.companion) as Memory[];
}
