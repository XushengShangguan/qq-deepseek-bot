import { createHmac, timingSafeEqual } from "crypto";
import { handleMessage } from "./conversation";
import { draftFileName, extractDocument, READABLE, renderPdf, saveDocument } from "./documents";
import { describeImage, qqFaceName } from "./media";
import { collectReceivedSticker, getSticker, markUsed, STICKER_LINE, stickerBase64 } from "./stickers";

// QQ channel via NapCat (OneBot 11). Only converts QQ <-> internal format and
// sends replies; persona and memory logic stay in conversation.ts (plan §5).
//
//   NapCat --(HTTP POST event)--> /api/qq/webhook --> handleIncoming()
//   sendPrivateMessage() --(HTTP POST /send_private_msg)--> NapCat

const NAPCAT_HTTP_URL = (process.env.NAPCAT_HTTP_URL || "http://127.0.0.1:3001").replace(/\/$/, "");
// Shared secret: NapCat signs events with it, and we send it as a Bearer token.
const QQ_TOKEN = process.env.QQ_TOKEN || "";
const COMPANION = process.env.QQ_COMPANION || "Mina";
// What she calls each person, e.g. "12345678:阿明,87654321:阿杰".
// Anyone not listed is called by their QQ nickname.
const USER_NAMES = new Map(
  (process.env.QQ_USER_NAMES || "")
    .split(",")
    .map((pair) => pair.split(":").map((s) => s.trim()))
    .filter(([qq, name]) => qq && name) as [string, string][]
);
// Each person's timezone, e.g. "12345678:Asia/Tokyo". Unlisted = this machine's.
const USER_TIMEZONES = new Map(
  (process.env.QQ_USER_TIMEZONES || "")
    .split(",")
    .map((pair) => pair.split(":").map((s) => s.trim()))
    .filter(([qq, tz]) => qq && tz) as [string, string][]
);
const ALLOWED_USERS = new Set(
  (process.env.QQ_ALLOWED_USERS || "").split(",").map((s) => s.trim()).filter(Boolean)
);
export const QQ_COMPANION = COMPANION;

export type QQPerson = { qq: string; name: string; timezone?: string };

/** The people she knows on QQ (QQ_ALLOWED_USERS), with what she calls them. */
export function qqPeople(): QQPerson[] {
  return Array.from(ALLOWED_USERS).map((qq) => ({
    qq,
    name: USER_NAMES.get(qq) || qq,
    timezone: USER_TIMEZONES.get(qq),
  }));
}

// People often send several short messages in a row; wait this long for more
// before replying, and answer them together.
const DEBOUNCE_MS = Number(process.env.QQ_DEBOUNCE_MS || 1200);

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
};

const MAX_FILE_BYTES = 20 * 1024 * 1024;

/** Where to download a file someone sent: NapCat's answer differs by version. */
async function fileUrl(data: Record<string, any>): Promise<string | null> {
  if (typeof data.url === "string" && /^https?:/.test(data.url)) return data.url;
  const id = data.file_id ?? data.fid;
  if (!id) return null;
  for (const action of ["get_private_file_url", "get_file"]) {
    try {
      const res = await callNapCat(action, { file_id: id }, 20000);
      const d = res.data ?? {};
      if (typeof d.url === "string" && /^https?:/.test(d.url)) return d.url;
      if (typeof d.base64 === "string" && d.base64) return `data:application/octet-stream;base64,${d.base64}`;
    } catch (err) {
      console.log(`WARNING: NapCat ${action} failed`, String(err));
    }
  }
  return null;
}

/** Read a PDF / Word file a friend sent and keep its text for her. */
async function readFileSegment(data: Record<string, any>, qq: string): Promise<string> {
  const name = String(data.file ?? data.name ?? "文件");
  if (!READABLE.test(name)) return `[文件：${name}，这种文件你打不开，只能看 PDF 和 Word]`;
  if (Number(data.file_size) > MAX_FILE_BYTES) return `[文件：${name}，太大了没打开]`;
  try {
    const url = await fileUrl(data);
    if (!url) throw new Error("下载不下来");
    const buf = url.startsWith("data:")
      ? Buffer.from(url.slice(url.indexOf(",") + 1), "base64")
      : Buffer.from(await (await fetch(url, { signal: AbortSignal.timeout(60000) })).arrayBuffer());
    const { text, summary } = await extractDocument(buf, name);
    saveDocument({ userId: `qq:${qq}`, companion: COMPANION }, name, text);
    console.log(`INFO: read ${name} from ${qq} (${summary})`);
    return `[文件：${name}，${summary}，你已经看完了，内容在"文件"里]`;
  } catch (err) {
    console.log(`WARNING: could not read ${name}`, String(err));
    return `[文件：${name}，没打开：${err instanceof Error ? err.message : "出错了"}]`;
  }
}

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

async function segmentToText(seg: Segment, qq: string): Promise<string> {
  const data = seg.data ?? {};
  switch (seg.type) {
    case "text":
      return String(data.text ?? "");
    case "image":
      // Stickers friends send go into her own collection too.
      if (isSticker(data)) collectReceivedSticker(COMPANION, data.url, qq);
      return describeImage(data.url, isSticker(data) ? "sticker" : "photo");
    case "mface":
      // Store stickers: describe the picture; the summary (e.g. "[开心]") is the fallback.
      collectReceivedSticker(COMPANION, data.url, qq);
      return data.url
        ? describeImage(data.url, "sticker")
        : `[表情包：${String(data.summary ?? "").replace(/[\[\]]/g, "")}]`;
    case "face":
      return qqFaceName(data.id);
    case "file":
      return readFileSegment(data, qq);
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
  const qq = String(event.user_id ?? "");
  const parts = await Promise.all(segs.map((seg) => segmentToText(seg, qq)));
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
    USER_NAMES.get(qq) || event.sender?.nickname || "你";
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
      // Count "reading time" from when the last message arrived, not from now.
      if (combined) await replyTo(qq, next.userName, combined, Date.now() - DEBOUNCE_MS);
    } catch (err) {
      console.error(`QQ reply to ${qq} failed`, err);
    }
  }, DEBOUNCE_MS);
  pending.set(qq, next);
  return null;
}

async function replyTo(qq: string, userName: string, text: string, receivedAt: number) {
  console.log(`QQ ${qq} -> ${text}`);
  const t0 = Date.now();
  const { text: reply, drafts } = await handleMessage({
    userId: `qq:${qq}`,
    userName,
    companion: COMPANION,
    text,
    userTimezone: USER_TIMEZONES.get(qq),
  });
  const generated = Date.now() - t0;
  await sendInPieces(qq, reply, { receivedAt, incoming: text });
  for (const d of drafts) {
    try {
      await sendFile(qq, await renderPdf(d), draftFileName(d));
    } catch (err) {
      console.log(`WARNING: file not sent: ${draftFileName(d)}`, String(err));
      await sendPrivateMessage(qq, "文件没发出去 我再试试").catch(() => {});
    }
  }
  console.log(`QQ ${qq} <- replied (generate ${generated}ms, total ${Date.now() - t0}ms)`);
}

// ---------- sending ----------

// NapCat occasionally hangs on a send (QQ client stalls); don't let one stuck
// message hold up the rest of the reply for a minute.
const SEND_TIMEOUT_MS = 10000;

async function callNapCat(
  action: string,
  params: Record<string, unknown>,
  timeoutMs = SEND_TIMEOUT_MS
) {
  const res = await fetch(`${NAPCAT_HTTP_URL}/${action}`, {
    method: "POST",
    signal: AbortSignal.timeout(timeoutMs),
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

/** Send a file (e.g. a PDF she made) as a QQ file message. */
export async function sendFile(qq: string, buf: Buffer, name: string) {
  await callNapCat(
    "upload_private_file",
    { user_id: Number(qq), file: `base64://${buf.toString("base64")}`, name },
    60000
  );
  console.log(`INFO: sent file ${name} to ${qq} (${buf.length} bytes)`);
}

/** Send one of her stickers; false if it no longer exists. */
async function sendSticker(qq: string, id: number): Promise<boolean> {
  const sticker = getSticker(COMPANION, id);
  const b64 = sticker && stickerBase64(sticker);
  if (!sticker || !b64) {
    console.log(`WARNING: sticker ${id} not found, skipped`);
    return false;
  }
  await callNapCat("send_private_msg", {
    user_id: Number(qq),
    message: [{ type: "image", data: { file: `base64://${b64}`, sub_type: 1, summary: "[动画表情]" } }],
  });
  markUsed(id);
  return true;
}

/** Is the bot account still logged in? */
export async function isOnline(): Promise<boolean> {
  try {
    const data = await callNapCat("get_status", {}, 5000);
    return data.data?.online === true;
  } catch {
    return false;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Lines longer than this get broken at sentence ends / commas as a fallback,
// in case the model writes one long sentence instead of several short messages.
const MAX_PIECE = 30;
// At most this many QQ messages per reply; extra lines are joined onto the
// last one. Bursts of messages are what gets a bot account risk-controlled.
const MAX_PIECES = Number(process.env.QQ_MAX_PIECES || 3);

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

/**
 * Split a reply into QQ-sized messages, the way people actually type.
 * A "[表情包:12]" line stays its own message (at most one per reply) and
 * counts toward the cap.
 */
export function splitIntoMessages(reply: string): string[] {
  const lines = reply
    // She sometimes tacks the sticker onto the end of a sentence.
    .replace(/[ \t]*(\[表情包[:：]\s*\d+\s*\])[ \t]*/g, "\n$1\n")
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean);
  const stickerAt = lines.findIndex((l) => STICKER_LINE.test(l));
  const sticker = stickerAt >= 0 ? lines[stickerAt] : undefined;
  const text = lines.filter((l) => !STICKER_LINE.test(l));
  const cap = MAX_PIECES - (sticker ? 1 : 0);
  // Only break up long lines when that doesn't push the count past the cap.
  const pieces = text.length < cap ? text.flatMap(breakLongLine) : text;
  const capped =
    pieces.length > cap ? [...pieces.slice(0, cap - 1), pieces.slice(cap - 1).join(" ")] : pieces;
  // Nobody ends a chat message with "。" or "，".
  const out = capped.map((p) => p.replace(/[。，,]+$/u, "").trim()).filter(Boolean);
  if (sticker) stickerAt === 0 ? out.unshift(sticker) : out.push(sticker);
  return out;
}

// Pace replies like a person on a phone: read the message, then type each
// line at a human speed (pinyin input is a few characters per second).
const TYPING_CPS = Number(process.env.QQ_TYPING_SPEED || 4);

const jitter = () => 0.75 + Math.random() * 0.5;

/** Time to read the incoming message before starting to type. */
function readingDelay(incoming: string) {
  return Math.min(3000, 400 + incoming.length * 60) * jitter();
}

/** Time to type one message. */
function typingDelay(text: string) {
  // Picking a sticker from the collection: about a second.
  if (STICKER_LINE.test(text)) return 1200 * jitter();
  // Emoticons/emoji are picked from the keyboard, not typed: count each run of
  // symbols as one keystroke.
  const keystrokes = text.replace(/[^\p{Script=Han}\p{L}\p{N}]+/gu, "·").length;
  return Math.min(8000, 500 + (keystrokes / TYPING_CPS) * 1000) * jitter();
}

/**
 * Send a reply as several short QQ messages with human pauses in between.
 * The first message waits for reading + typing time measured from when the
 * user's message arrived (time already spent generating counts toward it).
 */
export async function sendInPieces(
  qq: string,
  reply: string,
  timing?: { receivedAt: number; incoming: string }
) {
  const pieces = splitIntoMessages(reply);
  for (let i = 0; i < pieces.length; i++) {
    if (i === 0 && timing) {
      const due = timing.receivedAt + readingDelay(timing.incoming) + typingDelay(pieces[0]);
      await sleep(Math.max(0, due - Date.now()));
    } else if (i > 0) {
      await sleep(typingDelay(pieces[i]));
    }
    try {
      const sticker = pieces[i].match(STICKER_LINE);
      if (sticker) await sendSticker(qq, Number(sticker[1]));
      else await sendPrivateMessage(qq, pieces[i]);
    } catch (err) {
      // No blind retry: a timed-out send often still goes through, and a
      // duplicated message looks more robotic than a missing one.
      console.log(`WARNING: QQ message not sent: ${pieces[i]}`, String(err));
      if (!(await isOnline())) {
        console.log(
          "WARNING: 机器人 QQ 号已掉线，请打开 http://127.0.0.1:6099/webui 重新扫码登录"
        );
        return;
      }
    }
  }
}
