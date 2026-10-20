import { getDb } from "./db";
import type { Session } from "./memory";

// Numbers steer tone; events carry the actual story (plan §6.3–6.4).

export type RelationshipState = {
  closeness: number;
  trust: number;
  playfulness: number;
};

export type RelationshipEvent = {
  event: string;
  emotion?: string;
  importance?: number;
  effect?: Partial<RelationshipState>;
};

export type StoredEvent = {
  event: string;
  emotion: string | null;
  importance: number;
  created_at: number;
};

const INITIAL: RelationshipState = { closeness: 30, trust: 30, playfulness: 40 };
// One conversation turn shouldn't swing the relationship too far.
const MAX_DELTA = 5;
const KEYS: (keyof RelationshipState)[] = ["closeness", "trust", "playfulness"];

export function getRelationshipState({
  userId,
  companion,
}: Session): RelationshipState {
  const row = getDb()
    .prepare(
      `SELECT closeness, trust, playfulness FROM relationship_state
       WHERE user_id = ? AND companion = ?`
    )
    .get(userId, companion) as RelationshipState | undefined;
  return row ?? { ...INITIAL };
}

function saveState({ userId, companion }: Session, s: RelationshipState) {
  getDb()
    .prepare(
      `INSERT INTO relationship_state (user_id, companion, closeness, trust, playfulness, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id, companion) DO UPDATE SET
         closeness = excluded.closeness,
         trust = excluded.trust,
         playfulness = excluded.playfulness,
         updated_at = excluded.updated_at`
    )
    .run(userId, companion, s.closeness, s.trust, s.playfulness, Date.now());
}

export function recordRelationshipEvent(session: Session, e: RelationshipEvent) {
  if (!e.event?.trim()) return;
  const effect: Partial<RelationshipState> = {};
  const state = getRelationshipState(session);
  for (const k of KEYS) {
    const d = Math.round(Number(e.effect?.[k] ?? 0));
    if (!d) continue;
    const delta = Math.max(-MAX_DELTA, Math.min(MAX_DELTA, d));
    effect[k] = delta;
    state[k] = Math.max(0, Math.min(100, state[k] + delta));
  }

  const db = getDb();
  db.transaction(() => {
    db.prepare(
      `INSERT INTO relationship_events (user_id, companion, event, emotion, importance, effect, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      session.userId,
      session.companion,
      e.event.trim(),
      e.emotion ?? null,
      Math.max(0, Math.min(1, e.importance ?? 0.5)),
      JSON.stringify(effect),
      Date.now()
    );
    saveState(session, state);
  })();
}

export function getRecentEvents(
  { userId, companion }: Session,
  limit = 5
): StoredEvent[] {
  return getDb()
    .prepare(
      `SELECT event, emotion, importance, created_at FROM relationship_events
       WHERE user_id = ? AND companion = ?
       ORDER BY created_at DESC LIMIT ?`
    )
    .all(userId, companion, limit) as StoredEvent[];
}

function band(v: number, low: string, mid: string, high: string) {
  return v < 35 ? low : v < 70 ? mid : high;
}

/** Turn the numbers into tone guidance the model can actually follow. */
export function describeRelationship(s: RelationshipState): string {
  return [
    `亲密度 ${s.closeness}/100：` +
      band(
        s.closeness,
        "刚开始熟悉，友好但还有点矜持，不会太黏人。",
        "已经很熟了，会主动分享日常、偶尔撒娇。",
        "非常亲密，自然地表达想念和在乎，会用亲昵的称呼。"
      ),
    `信任 ${s.trust}/100：` +
      band(
        s.trust,
        "还不太会聊自己的心事。",
        "愿意说一些自己的烦恼和真实想法。",
        "毫无保留，能聊很私密、很脆弱的话题。"
      ),
    `俏皮 ${s.playfulness}/100：` +
      band(
        s.playfulness,
        "语气偏温柔认真。",
        "偶尔开玩笑、斗嘴。",
        "很爱逗对方、调侃、玩梗。"
      ),
  ].join("\n");
}
