import { createHmac, timingSafeEqual } from "crypto";
import { handleMessage } from "./conversation";
import { describeImage, qqFaceName } from "./media";

// QQ channel via NapCat (OneBot 11). Only converts QQ <-> internal format and
// sends replies; persona and memory logic stay in conversation.ts (plan §5).
//
//   NapCat --(HTTP POST event)--> /api/qq/webhook --> handleIncoming()
//   sendPrivateMessage() --(HTTP POST /send_private_msg)--> NapCat

const NAPCAT_HTTP_URL = (process.env.NAPCAT_HTTP_URL || "http://127.0.0.1:3001").replace(/\/$/, "");
// Shared secret: NapCat signs events with it, and we send it as a Bearer token.
const QQ_TOKEN = process.env.QQ_TOKEN || "";
const COMPANION = process.env.QQ_COMPANION || "Mina";
const ALLOWED_USERS = new Set(
  (process.env.QQ_ALLOWED_USERS || "").split(",").map((s) => s.trim()).filter(Boolean)
);
// People often send several short messages in a row; wait this long for more
// before replying, and answer them together.
const DEBOUNCE_MS = Number(process.env.QQ_DEBOUNCE_MS || 2000);

type Segment = { type: string; data?: Record<string, any> };

export type OneBotEvent = {
  post_type: string;
  message_type?: string;
  sub_type?: string;
  self_id?: number;
  user_id?: number;
  message?: Segment[] | string;
  raw_message?: string;
  sender?: { nickname?: string; card?: string };
};

// ---------- receiving ----------

export function verifySignature(rawBody: string, header: string | null): boolean {
  if (!QQ_TOKEN) return true;
  if (!header) return false;
  const expected = "sha1=" + createHmac("sha1", QQ_TOKEN).update(rawBody).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(header);
  return a.length === b.length && timingSafeEqual(a, b);
}

const PLACEHOLDERS: Record<string, string> = {
  record: "[语音]",
  video: "[视频]",
  file: "[文件]",
};

function unescapeCQ(s: string) {
  return s
    .replace(/&#91;/g, "[")
    .replace(/&#93;/g, "]")
    .replace(/&#44;/g, ",")
    .replace(/&amp;/g, "&");
}

// QQ sends stickers as image segments with sub_type 1 (or a summary like "[动画表情]").
function isSticker(data: Record<string, any> = {}) {
  return Number(data.sub_type) === 1 || /表情/.test(String(data.summary ?? ""));
}

async function segmentToText(seg: Segment): Promise<string> {
  const data = seg.data ?? {};
  switch (seg.type) {
    case "text":
      return String(data.text ?? "");
    case "image":
      return describeImage(data.url, isSticker(data) ? "sticker" : "photo");
    case "mface":
      // Store stickers: describe the picture; the summary (e.g. "[开心]") is the fallback.
      return data.url
        ? describeImage(data.url, "sticker")
        : `[表情包：${String(data.summary ?? "").replace(/[\[\]]/g, "")}]`;
    case "face":
      return qqFaceName(data.id);
    default:
      return PLACEHOLDERS[seg.type] ?? "";
  }
}

// CQ-code string format: "hi[CQ:image,file=x.jpg,url=https://...]".
function parseCQ(raw: string): Segment[] {
  const segs: Segment[] = [];
  const re = /\[CQ:(\w+)((?:,[^\]]*)?)\]/g;
  let last = 0;
  for (let m; (m = re.exec(raw)); last = re.lastIndex) {
    if (m.index > last) segs.push({ type: "text", data: { text: unescapeCQ(raw.slice(last, m.index)) } });
    const data: Record<string, string> = {};
    for (const kv of m[2].split(",").filter(Boolean)) {
      const i = kv.indexOf("=");
      if (i > 0) data[kv.slice(0, i)] = unescapeCQ(kv.slice(i + 1));
    }
    segs.push({ type: m[1], data });
  }
  if (last < raw.length) segs.push({ type: "text", data: { text: unescapeCQ(raw.slice(last)) } });
  return segs;
}

/** Turn a OneBot message into text; images and stickers become short descriptions. */
export async function messageToText(event: OneBotEvent): Promise<string> {
  const msg = event.message;
  const segs = Array.isArray(msg)
    ? msg
    : parseCQ(typeof msg === "string" ? msg : event.raw_message ?? "");
  const parts = await Promise.all(segs.map(segmentToText));
  return parts.join("").trim();
}

type Pending = { parts: Promise<string>[]; userName: string; timer: NodeJS.Timeout };
const pending = new Map<string, Pending>();

/**
 * Accept a OneBot event. Returns why it was ignored, or null if it was queued.
 * The reply is generated and sent asynchronously.
 */
export function handleIncoming(event: OneBotEvent): string | null {
  if (event.post_type !== "message") return "not a message";
  if (event.message_type !== "private") return "not a private message";
  if (!event.user_id || event.user_id === event.self_id) return "own message";

  const qq = String(event.user_id);
  if (ALLOWED_USERS.size && !ALLOWED_USERS.has(qq)) {
    console.log(`INFO: ignoring QQ ${qq} (not in QQ_ALLOWED_USERS)`);
    return "user not allowed";
  }

  // Start describing images right away, in parallel with the debounce wait.
  const text = messageToText(event).catch((err) => {
    console.error("could not read QQ message", err);
    return "";
  });

  const userName =
    process.env.QQ_USER_NAME || event.sender?.nickname || "你";
  const entry = pending.get(qq);
  if (entry) {
    clearTimeout(entry.timer);
    entry.parts.push(text);
  }
  const next: Pending = entry ?? { parts: [text], userName, timer: undefined as any };
  next.timer = setTimeout(async () => {
    pending.delete(qq);
    try {
      const combined = (await Promise.all(next.parts)).filter(Boolean).join("\n");
      if (combined) await replyTo(qq, next.userName, combined);
    } catch (err) {
      console.error(`QQ reply to ${qq} failed`, err);
    }
  }, DEBOUNCE_MS);
  pending.set(qq, next);
  return null;
}

async function replyTo(qq: string, userName: string, text: string) {
  console.log(`QQ ${qq} -> ${text}`);
  const reply = await handleMessage({
    userId: `qq:${qq}`,
    userName,
    companion: COMPANION,
    text,
  });
  await sendInPieces(qq, reply);
}

// ---------- sending ----------

async function callNapCat(action: string, params: Record<string, unknown>) {
  const res = await fetch(`${NAPCAT_HTTP_URL}/${action}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(QQ_TOKEN ? { Authorization: `Bearer ${QQ_TOKEN}` } : {}),
    },
    body: JSON.stringify(params),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.status === "failed") {
    throw new Error(`NapCat ${action} failed (${res.status}): ${JSON.stringify(data)}`);
  }
  return data;
}

export function sendPrivateMessage(qq: string, text: string) {
  return callNapCat("send_private_msg", { user_id: Number(qq), message: text });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Lines longer than this get broken at sentence ends / commas as a fallback,
// in case the model writes one long sentence instead of several short messages.
const MAX_PIECE = 20;

function breakLongLine(line: string): string[] {
  const out: string[] = [];
  let rest = line.trim();
  while (rest.length > MAX_PIECE) {
    const head = rest.slice(0, MAX_PIECE + 1);
    let cut = -1;
    for (const re of [/[。！？!?～~…]+/g, /[，,；;]/g]) {
      for (const m of Array.from(head.matchAll(re))) {
        const end = (m.index ?? 0) + m[0].length;
        if (end >= 5 && end < rest.length) cut = end;
      }
      if (cut > 0) break;
    }
    if (cut < 0) break;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

/** Split a reply into QQ-sized messages, the way people actually type. */
export function splitIntoMessages(reply: string): string[] {
  return reply
    .split(/\n+/)
    .flatMap(breakLongLine)
    // Nobody ends a chat message with "。" or "，".
    .map((p) => p.replace(/[。，,]+$/u, "").trim())
    .filter(Boolean);
}

/** Typing time for one message: roughly reading + typing speed, with some jitter. */
function typingDelay(text: string) {
  const base = 700 + text.length * 180;
  return Math.min(5000, base) * (0.8 + Math.random() * 0.4);
}

/** Send a reply as several short QQ messages with natural pauses in between. */
export async function sendInPieces(qq: string, reply: string) {
  const pieces = splitIntoMessages(reply);
  for (let i = 0; i < pieces.length; i++) {
    if (i > 0) await sleep(typingDelay(pieces[i]));
    await sendPrivateMessage(qq, pieces[i]);
  }
}
