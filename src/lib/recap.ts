import { getDb } from "./db";
import { getLLM } from "./llm";
import type { Session } from "./memory";
import { COMPANION_TIMEZONE, formatStamp } from "./time";

// What she remembers of a conversation once it's older than the chat window.
// Long-term memories keep facts ("he lives in Tokyo"), not how talks went: what
// they talked about, what she already asked, what she promised or agreed to.
// Without that she re-asked questions from an hour ago and broke agreements
// made in chat. So messages about to leave the window are folded, a batch at a
// time, into a running recap per person, which goes into her prompts.

const WINDOW = Number(process.env.RECENT_MESSAGES || 60);
// Fold once this many messages have left the window since the last recap.
const BATCH = 20;
// On the first recap, look this far back at most.
const FIRST_LOOKBACK = 200;
const MAX_CHARS = 700;

type Row = { id: number; role: "user" | "assistant"; content: string; created_at: number };

export function recapFor({ userId, companion }: Session): string {
  const r = getDb()
    .prepare(`SELECT text FROM chat_recaps WHERE user_id = ? AND companion = ?`)
    .get(userId, companion) as { text: string } | undefined;
  return r?.text ?? "";
}

const SYSTEM = `你在帮一个角色整理她和一个朋友的聊天经过，好让她以后接得上话。只输出整理结果，不要别的话。`;

function prompt(name: string, previous: string, rows: Row[]): string {
  const talk = rows
    .map(
      (r) =>
        `[${formatStamp(r.created_at, COMPANION_TIMEZONE)}] ${r.role === "user" ? name : "她"}：${r.content.replace(/\n/g, " / ")}`
    )
    .join("\n");
  return `之前整理好的：
${previous || "（还没有）"}

新的一段聊天：
${talk}

把两部分合起来重写一份，整份不超过 ${MAX_CHARS} 字，纯文字不用 Markdown，按下面的顺序分三块：
说好的：两人说好的事、她答应的事、${name}让她做或者别做的事，一条一行；还作数的留着，做完了或明显过期的删掉。
她问过的：她已经问过${name}的问题和${name}的回答（没答就写没答），一条一行，很短，免得她再问一遍。
聊过的：按时间记聊了哪些事，带上大概时间（几号、上午下午晚上）；只记事，不复述原话；越早的越简略，几天前的一句带过。
只写聊天里真有的，别补别猜；分不清是谁说的就不写。`;
}

/**
 * Fold messages that have left the chat window into the recap. Cheap to call
 * after every turn: does nothing until a batch has piled up. Two server
 * processes may both try; whoever saves first wins, the other's result is
 * dropped.
 */
export async function updateRecap(session: Session, name: string) {
  const db = getDb();
  const { userId, companion } = session;
  const cur = db
    .prepare(`SELECT text, upto_id FROM chat_recaps WHERE user_id = ? AND companion = ?`)
    .get(userId, companion) as { text: string; upto_id: number } | undefined;
  // Oldest message still inside the window.
  const edge = db
    .prepare(
      `SELECT id FROM messages WHERE user_id = ? AND companion = ? ORDER BY id DESC LIMIT 1 OFFSET ?`
    )
    .get(userId, companion, WINDOW - 1) as { id: number } | undefined;
  if (!edge) return;
  const since = cur?.upto_id ?? 0;
  const rows = (
    db
      .prepare(
        `SELECT id, role, content, created_at FROM messages
         WHERE user_id = ? AND companion = ? AND id > ? AND id < ?
         ORDER BY id DESC LIMIT ?`
      )
      .all(userId, companion, since, edge.id, cur ? 1000 : FIRST_LOOKBACK) as Row[]
  ).reverse();
  if (rows.length < BATCH) return;

  const llm = await getLLM();
  const text = (
    await llm.generate(SYSTEM, [{ role: "user", content: prompt(name, cur?.text ?? "", rows) }], {
      purpose: "extract",
      json: false,
      maxTokens: 1500,
    })
  ).trim();
  if (!text) return;
  // The model runs long now and then; the part cut off is the oldest talk.
  const clipped = text.replace(/\*\*/g, "").slice(0, MAX_CHARS * 1.5);
  const upto = rows[rows.length - 1].id;
  const saved = cur
    ? db
        .prepare(`UPDATE chat_recaps SET text = ?, upto_id = ?, updated_at = ? WHERE user_id = ? AND companion = ? AND upto_id = ?`)
        .run(clipped, upto, Date.now(), userId, companion, since).changes
    : db
        .prepare(`INSERT OR IGNORE INTO chat_recaps (user_id, companion, text, upto_id, updated_at) VALUES (?, ?, ?, ?, ?)`)
        .run(userId, companion, clipped, upto, Date.now()).changes;
  if (saved) console.log(`INFO: recap for ${userId} updated (${rows.length} messages folded in)`);
}
