import { createHash } from "crypto";
import fs from "fs";
import path from "path";
import { getDb } from "./db";
import { getLLM } from "./llm";
import { fetchImage, toDataUrl } from "./media";

// Her sticker collection. She picks images up while browsing (Bilibili
// comment pictures, Tieba floors) and from stickers her friends send; each is
// checked by the vision model (is it a reaction image at all, is it safe to
// send from a bot account) and saved with a note on when to use it. In chat
// she sends one by writing [表情包:<id>] on its own line.

const ENABLED = (process.env.STICKERS || "on") !== "off";
const DIR = path.join(path.dirname(process.env.DB_PATH || "data/companion.db"), "stickers");
const MAX_STICKERS = Number(process.env.STICKERS_MAX || 200);
const MAX_BYTES = 3 * 1024 * 1024;
// How many she sees in the chat prompt.
const PROMPT_STICKERS = 25;

export const STICKER_LINE = /^\s*\[表情包[:：]\s*(\d+)\s*\]\s*$/;

export type Sticker = {
  id: number;
  file: string;
  shows: string;
  use_when: string;
  source: string;
  use_count: number;
};

export type Look = { sticker: boolean; ok: boolean; shows: string; useWhen: string };

const LOOK_PROMPT = `看这张图，只输出一行 JSON，不要别的文字：
{"sticker": 能不能在聊天里当表情包用（梗图、表情、反应图、带字的图算；长截图、文章、普通照片、风景、广告、二维码不算）,
 "ok": 适不适合从 QQ 号发出去（有色情、血腥暴力、政治敏感内容、真实普通人的照片就不适合）,
 "shows": "画面是什么、上面写了什么字，一句话",
 "use_when": "聊天里什么时候适合发，一句话，比如：对方说了离谱的话，表示无语"}`;

function parseLook(text: string): Look | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]);
    return {
      sticker: j.sticker === true,
      ok: j.ok === true,
      shows: String(j.shows ?? "").trim(),
      useWhen: String(j.use_when ?? "").trim(),
    };
  } catch {
    return null;
  }
}

// Images she has looked at recently, so saving one doesn't download and
// look at it a second time.
const state = globalThis as unknown as { stickerLooks?: Map<string, { img: { buf: Buffer; mime: string }; look: Look }> };
state.stickerLooks ??= new Map();

/** Download an image and have the vision model look at it. */
export async function lookAtImage(url: string): Promise<Look> {
  const cached = state.stickerLooks!.get(url);
  if (cached) return cached.look;
  const img = await fetchImage(url, MAX_BYTES);
  if (!img) throw new Error("图打不开或太大");
  const llm = await getLLM();
  if (!llm.describeImage) throw new Error("现在看不了图");
  const look = parseLook(await llm.describeImage(toDataUrl(img), LOOK_PROMPT));
  if (!look) throw new Error("没看明白这张图");
  if (state.stickerLooks!.size > 50) state.stickerLooks!.clear();
  state.stickerLooks!.set(url, { img, look });
  return look;
}

function evictIfFull(companion: string) {
  const db = getDb();
  const { n } = db.prepare(`SELECT count(*) AS n FROM stickers WHERE companion = ?`).get(companion) as { n: number };
  if (n < MAX_STICKERS) return;
  // Drop the one used least, longest ago.
  const old = db
    .prepare(
      `SELECT id, file FROM stickers WHERE companion = ?
       ORDER BY use_count ASC, COALESCE(last_used_at, created_at) ASC LIMIT 1`
    )
    .get(companion) as { id: number; file: string } | undefined;
  if (!old) return;
  db.prepare(`DELETE FROM stickers WHERE id = ?`).run(old.id);
  fs.rmSync(path.join(DIR, old.file), { force: true });
}

/**
 * Save an image to her collection if it passes the look. useWhen is her own
 * note on when to send it (falls back to the vision model's suggestion).
 * Returns why it wasn't saved, or the new sticker.
 */
export async function saveSticker(
  companion: string,
  url: string,
  source: string,
  useWhen?: string
): Promise<{ saved: Sticker } | { skipped: string }> {
  if (!ENABLED) return { skipped: "表情包功能关着" };
  const look = await lookAtImage(url);
  if (!look.sticker) return { skipped: `这不太像表情包（${look.shows}）` };
  if (!look.ok) return { skipped: "这张发出去不合适" };
  const { img } = state.stickerLooks!.get(url)!;
  const hash = createHash("sha1").update(img.buf).digest("hex");
  const db = getDb();
  const existing = db.prepare(`SELECT id FROM stickers WHERE companion = ? AND hash = ?`).get(companion, hash) as
    | { id: number }
    | undefined;
  if (existing) return { skipped: `已经收藏过了（编号 ${existing.id}）` };

  evictIfFull(companion);
  const ext = img.mime.split("/")[1].replace("jpeg", "jpg");
  const file = `${hash.slice(0, 16)}.${ext}`;
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(path.join(DIR, file), img.buf);
  const note = (useWhen || look.useWhen || "随时").slice(0, 60);
  const { lastInsertRowid } = db
    .prepare(
      `INSERT INTO stickers (companion, file, hash, shows, use_when, source, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(companion, file, hash, look.shows.slice(0, 80), note, source, Date.now());
  console.log(`INFO: ${companion} saved sticker ${lastInsertRowid}: ${look.shows} / ${note}`);
  return {
    saved: { id: Number(lastInsertRowid), file, shows: look.shows, use_when: note, source, use_count: 0 },
  };
}

/** Collect a sticker a friend sent, in the background; never throws. */
export function collectReceivedSticker(companion: string, url: string | undefined, qq: string) {
  if (!ENABLED || !url) return;
  saveSticker(companion, url, `qq:${qq}`).catch((err) => console.log("WARNING: sticker not collected", String(err)));
}

export function getSticker(companion: string, id: number): Sticker | undefined {
  return getDb()
    .prepare(`SELECT id, file, shows, use_when, source, use_count FROM stickers WHERE companion = ? AND id = ?`)
    .get(companion, id) as Sticker | undefined;
}

/** The image of a sticker as base64, for sending through NapCat. */
export function stickerBase64(s: Sticker): string | null {
  try {
    return fs.readFileSync(path.join(DIR, s.file)).toString("base64");
  } catch {
    return null;
  }
}

export function markUsed(id: number) {
  getDb().prepare(`UPDATE stickers SET use_count = use_count + 1, last_used_at = ? WHERE id = ?`).run(Date.now(), id);
}

/**
 * Stickers listed in the chat prompt: the newest ones plus a random handful
 * of the rest, so older ones still come up now and then.
 */
export function stickersForPrompt(companion: string): Sticker[] {
  if (!ENABLED) return [];
  const db = getDb();
  const recent = db
    .prepare(
      `SELECT id, file, shows, use_when, source, use_count FROM stickers WHERE companion = ?
       ORDER BY id DESC LIMIT ?`
    )
    .all(companion, Math.ceil(PROMPT_STICKERS / 2)) as Sticker[];
  const others = db
    .prepare(
      `SELECT id, file, shows, use_when, source, use_count FROM stickers WHERE companion = ? AND id NOT IN (${
        recent.map((s) => s.id).join(",") || "0"
      }) ORDER BY random() LIMIT ?`
    )
    .all(companion, PROMPT_STICKERS - recent.length) as Sticker[];
  return [...recent, ...others].sort((a, b) => a.id - b.id);
}

/** Her whole collection, newest first (debug view). */
export function listStickers(companion: string): (Sticker & { created_at: number })[] {
  return getDb()
    .prepare(
      `SELECT id, file, shows, use_when, source, use_count, created_at FROM stickers WHERE companion = ? ORDER BY id DESC`
    )
    .all(companion) as (Sticker & { created_at: number })[];
}

export function countStickers(companion: string): number {
  return (getDb().prepare(`SELECT count(*) AS n FROM stickers WHERE companion = ?`).get(companion) as { n: number }).n;
}
