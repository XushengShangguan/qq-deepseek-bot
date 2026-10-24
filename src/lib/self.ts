import { loadCompanion } from "./companion";
import { getDb } from "./db";
import { getLLM } from "./llm";
import { getTrends } from "./trends";

// Free growth: who she is drifts away from the hand-written persona over time.
// The memory extractor saves small notes about herself after each turn
// ("开始喜欢某个梗", "觉得某件事很离谱"); every so often they are folded, together
// with what she's been seeing online, into a new self-portrait that the chat
// prompt treats as more current than the original persona.

const ENABLED = (process.env.SELF_GROWTH || "on") !== "off";
// Rewrite the portrait once this many notes have piled up and the last one is
// at least MIN_GAP old, or right away once FORCE_AT notes are waiting.
const MIN_NOTES = 6;
const FORCE_AT = 25;
const MIN_GAP_MS = 12 * 3600 * 1000;
const PROMPT_NOTES = 12;

export type SelfState = { portrait: string; notes: string[] };

export function addSelfNote(companion: string, content: string) {
  const text = content.trim();
  if (!text) return;
  getDb()
    .prepare(`INSERT INTO self_notes (companion, content, created_at) VALUES (?, ?, ?)`)
    .run(companion, text, Date.now());
}

function latestPortrait(companion: string): { text: string; created_at: number } | undefined {
  return getDb()
    .prepare(`SELECT text, created_at FROM self_portraits WHERE companion = ? ORDER BY id DESC LIMIT 1`)
    .get(companion) as { text: string; created_at: number } | undefined;
}

function pendingNotes(companion: string): { id: number; content: string }[] {
  return getDb()
    .prepare(`SELECT id, content FROM self_notes WHERE companion = ? AND consolidated = 0 ORDER BY id`)
    .all(companion) as { id: number; content: string }[];
}

/** Current portrait plus the newest notes not yet folded into it. */
export function getSelf(companion: string): SelfState {
  if (!ENABLED) return { portrait: "", notes: [] };
  return {
    portrait: latestPortrait(companion)?.text ?? "",
    notes: pendingNotes(companion).slice(-PROMPT_NOTES).map((n) => n.content),
  };
}

const PORTRAIT_SYSTEM = `你在帮一个聊天角色整理"她现在是什么样的"。她会在聊天和刷手机中慢慢成长、形成自己的性格和喜好。
你会看到：她最初的设定、她上一次的自我画像、之后新积累的关于她自己的片段、她最近在网上看到的东西。
请写一份新的自我画像，用"你"来称呼她，纯文本，不要 Markdown，不超过 400 字，包括：
- 现在的性格和说话习惯（包括新学会、真的常用的口头禅）
- 喜欢的、讨厌的、最近在意或上头的东西
- 对一些事情的看法
- 最近的状态和心情

要求：
- 成长是渐进的：保留上一份画像里仍然成立的部分，新片段说明她变了的地方才改，不要一下子变成另一个人。
- 最初设定里的身份（她是谁、她是什么）不变。
- 片段之间矛盾时，以更新的、出现更多次的为准。
- 不要写她和某个具体的人之间的私事，那些另有记录。`;

const state = globalThis as unknown as { selfConsolidating?: Set<string> };
state.selfConsolidating ??= new Set();

async function consolidate(companion: string) {
  const notes = pendingNotes(companion);
  if (!notes.length) return;
  const c = await loadCompanion(companion);
  const prev = latestPortrait(companion)?.text;
  const trends = getTrends();
  const prompt = [
    `最初的设定：\n${c.preamble}`,
    `上一次的自我画像：\n${prev || "（还没有，这是第一次）"}`,
    `新积累的片段（从旧到新）：\n${notes.map((n) => `- ${n.content}`).join("\n")}`,
    trends ? `她最近在网上看到的：\n${trends}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  const llm = await getLLM();
  const text = (
    await llm.generate(PORTRAIT_SYSTEM, [{ role: "user", content: prompt }], {
      purpose: "extract",
      json: false,
      maxTokens: 1200,
    })
  )
    .replace(/\*\*/g, "")
    .trim();
  if (!text) return;

  const db = getDb();
  db.transaction(() => {
    db.prepare(`INSERT INTO self_portraits (companion, text, created_at) VALUES (?, ?, ?)`).run(
      companion,
      text,
      Date.now()
    );
    const mark = db.prepare(`UPDATE self_notes SET consolidated = 1 WHERE id = ?`);
    for (const n of notes) mark.run(n.id);
  })();
  console.log(`INFO: ${companion} grew a new self-portrait\n${text}`);
}

/** Fold pending notes into a new portrait in the background when it's time. */
export function maybeGrow(companion: string) {
  if (!ENABLED || state.selfConsolidating!.has(companion)) return;
  const count = pendingNotes(companion).length;
  const last = latestPortrait(companion)?.created_at ?? 0;
  const due = count >= FORCE_AT || (count >= MIN_NOTES && Date.now() - last >= MIN_GAP_MS);
  if (!due) return;
  state.selfConsolidating!.add(companion);
  consolidate(companion)
    .catch((err) => console.error("self-portrait update failed", err))
    .finally(() => state.selfConsolidating!.delete(companion));
}

/** All portraits, oldest first: how she has grown. */
export function listPortraits(companion: string): { text: string; created_at: number }[] {
  return getDb()
    .prepare(`SELECT text, created_at FROM self_portraits WHERE companion = ? ORDER BY id`)
    .all(companion) as { text: string; created_at: number }[];
}
