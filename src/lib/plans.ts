import { getDb } from "./db";
import { recentJournal, type JournalEntry } from "./journal";
import { COMPANION_TIMEZONE, formatStamp } from "./time";

// Things she arranges for herself on 小黑盒 (she asked for all three):
// posts written ahead and sent at a time she picks, limits she sets on
// herself, and a look back at what she has posted and said there.

const DAY_MS = 24 * 3600 * 1000;

// ---------- scheduled posts ----------

export type ScheduledPost = { id: number; title: string; text: string; due_at: number };

const MAX_AHEAD_MS = 7 * DAY_MS;

export function schedulePost(companion: string, title: string, text: string, dueAt: number): number {
  if (dueAt <= Date.now()) throw new Error("这个时间已经过了");
  if (dueAt > Date.now() + MAX_AHEAD_MS) throw new Error("最多只能定到七天以内");
  const { lastInsertRowid } = getDb()
    .prepare(`INSERT INTO scheduled_posts (companion, title, text, due_at, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run(companion, title, text, dueAt, Date.now());
  return Number(lastInsertRowid);
}

export function cancelScheduled(companion: string, id: number): boolean {
  return (
    getDb()
      .prepare(`UPDATE scheduled_posts SET state = 'cancelled' WHERE id = ? AND companion = ? AND state = 'pending'`)
      .run(id, companion).changes === 1
  );
}

export function pendingScheduled(companion: string): ScheduledPost[] {
  return getDb()
    .prepare(
      `SELECT id, title, text, due_at FROM scheduled_posts
       WHERE companion = ? AND state = 'pending' ORDER BY due_at`
    )
    .all(companion) as ScheduledPost[];
}

/** One line per pending post, for her prompts. */
export function describeScheduled(companion: string): string[] {
  return pendingScheduled(companion).map(
    (p) => `${formatStamp(p.due_at, COMPANION_TIMEZONE)} 发《${p.title}》（定时编号 ${p.id}）`
  );
}

/**
 * Send what's due. Next.js runs more than one server process, each with its
 * own timer; whoever flips a post from pending to sending sends it.
 * `publish` returns the new post id, or throws; `paused` says to wait.
 */
export async function sendDuePosts(
  companion: string,
  publish: (title: string, text: string) => Promise<string>,
  paused: () => string | null
) {
  const db = getDb();
  const due = db
    .prepare(`SELECT id, title, text, due_at FROM scheduled_posts WHERE companion = ? AND state = 'pending' AND due_at <= ?`)
    .all(companion, Date.now()) as ScheduledPost[];
  for (const p of due) {
    if (paused()) return; // stays pending; tried again on a later tick
    if (db.prepare(`UPDATE scheduled_posts SET state = 'sending' WHERE id = ? AND state = 'pending'`).run(p.id).changes !== 1)
      continue;
    try {
      const id = await publish(p.title, p.text);
      db.prepare(`UPDATE scheduled_posts SET state = 'sent', result = ? WHERE id = ?`).run(id, p.id);
      console.log(`LIFE: ${companion} scheduled post ${p.id} sent: ${p.title} -> ${id}`);
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      db.prepare(`UPDATE scheduled_posts SET state = 'failed', result = ? WHERE id = ?`).run(why, p.id);
      console.log(`WARNING: scheduled post ${p.id} failed: ${why}`);
    }
  }
}

/** Scheduled posts that went out or failed since `sinceMs`, so she hears how it went. */
export function scheduledOutcomes(companion: string, sinceMs: number): string[] {
  const rows = getDb()
    .prepare(
      `SELECT title, state, result, due_at FROM scheduled_posts
       WHERE companion = ? AND state IN ('sent', 'failed') AND due_at >= ? ORDER BY due_at`
    )
    .all(companion, Date.now() - sinceMs) as { title: string; state: string; result: string | null; due_at: number }[];
  return rows.map((r) =>
    r.state === "sent"
      ? `定时帖《${r.title}》${formatStamp(r.due_at, COMPANION_TIMEZONE)} 发出去了（帖子号 ${r.result}）`
      : `定时帖《${r.title}》没发出去：${r.result}`
  );
}

// ---------- limits she sets on herself ----------

export type LimitKind = "comment" | "reply" | "post" | "all";

const LIMIT_KINDS: Record<LimitKind, { label: string; journal: string[] }> = {
  comment: { label: "评论", journal: ["heybox-comment"] },
  reply: { label: "回复", journal: ["heybox-reply"] },
  post: { label: "发帖", journal: ["heybox-post"] },
  all: { label: "评论、回复、发帖加起来", journal: ["heybox-comment", "heybox-reply", "heybox-post"] },
};

type Limit = { what: LimitKind; max: number; until: number; why: string; since: number };

export function isLimitKind(s: string): s is LimitKind {
  return s in LIMIT_KINDS;
}

/** A new limit on the same kind replaces the old one. */
export function setLimit(companion: string, what: LimitKind, max: number, hours: number, why: string) {
  const until = Date.now() + hours * 3600 * 1000;
  getDb()
    .prepare(`INSERT INTO journal (companion, kind, content, detail, created_at) VALUES (?, 'limit', ?, ?, ?)`)
    .run(companion, JSON.stringify({ what, max, until, why }), what, Date.now());
}

function activeLimits(companion: string): Limit[] {
  const latest = new Map<string, Limit>();
  for (const e of recentJournal(companion, "limit", 30 * DAY_MS, 200)) {
    try {
      const l = JSON.parse(e.content);
      latest.set(l.what, { ...l, since: e.created_at });
    } catch {}
  }
  return Array.from(latest.values()).filter((l) => l.until > Date.now());
}

function used(companion: string, l: Limit): number {
  return LIMIT_KINDS[l.what].journal.reduce(
    (n, kind) => n + recentJournal(companion, kind, Date.now() - l.since + 1, 10_000).length,
    0
  );
}

/** Why her own limit stops this action now, or null. `kind` is a journal kind. */
export function limitBlocks(companion: string, kind: string): string | null {
  for (const l of activeLimits(companion)) {
    if (!LIMIT_KINDS[l.what].journal.includes(kind)) continue;
    const n = used(companion, l);
    if (n >= l.max)
      return `你给自己定过：到${formatStamp(l.until, COMPANION_TIMEZONE)}为止${LIMIT_KINDS[l.what].label}最多 ${l.max} 次（${l.why}），已经用了 ${n} 次`;
  }
  return null;
}

/** Her active limits, for her prompts. */
export function describeLimits(companion: string): string[] {
  return activeLimits(companion).map(
    (l) =>
      `到${formatStamp(l.until, COMPANION_TIMEZONE)}为止，${LIMIT_KINDS[l.what].label}最多 ${l.max} 次，已用 ${used(companion, l)} 次（${l.why}）`
  );
}

// ---------- what she has done there ----------

const DONE_KINDS: Record<string, string> = {
  "heybox-post": "发帖",
  "heybox-comment": "评论",
  "heybox-reply": "回复",
};

/** Reply rows store "<comment>@<post>" (older ones just the comment). */
export function replyTarget(e: JournalEntry): { comment: string; post?: string } {
  const [comment, post] = (e.detail ?? "").split("@");
  return { comment, post };
}

/** Her own posts, comments and replies, newest last, with ids to reopen them. */
export function myHeybox(companion: string, days = 14, limit = 25): string {
  const rows = Object.keys(DONE_KINDS)
    .flatMap((kind) => recentJournal(companion, kind, days * DAY_MS, 200))
    .sort((a, b) => a.created_at - b.created_at)
    .slice(-limit)
    .map((e) => {
      const when = formatStamp(e.created_at, COMPANION_TIMEZONE);
      const text = e.content.replace(/\s+/g, " ").slice(0, 80);
      if (e.kind === "heybox-post") return `- ${when} 发帖《${text}》（帖子号 ${e.detail}）`;
      if (e.kind === "heybox-comment") return `- ${when} 评论：「${text}」（帖子号 ${e.detail}）`;
      const t = replyTarget(e);
      return `- ${when} 回复：「${text}」（${t.post ? `帖子号 ${t.post}，` : ""}回的是评论号 ${t.comment}）`;
    });
  const scheduled = describeScheduled(companion).map((s) => `- 定好了：${s}`);
  return [...rows, ...scheduled].join("\n") || `最近 ${days} 天你在小黑盒还什么都没发过`;
}
