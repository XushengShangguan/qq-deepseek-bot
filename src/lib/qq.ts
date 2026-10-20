import { createHmac, timingSafeEqual } from "crypto";
import { handleMessage } from "./conversation";

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
  image: "[图片]",
  mface: "[表情包]",
  face: "[表情]",
  record: "[语音]",
  video: "[视频]",
  file: "[文件]",
};

/** Flatten a OneBot message (array or CQ-code string) into plain text. */
export function extractText(event: OneBotEvent): string {
  const msg = event.message;
  if (Array.isArray(msg)) {
    return msg
      .map((seg) =>
        seg.type === "text" ? String(seg.data?.text ?? "") : PLACEHOLDERS[seg.type] ?? ""
      )
      .join("")
      .trim();
  }
  const raw = typeof msg === "string" ? msg : event.raw_message ?? "";
  return raw
    .replace(/\[CQ:(\w+)[^\]]*\]/g, (_, type: string) => PLACEHOLDERS[type] ?? "")
    .replace(/&#91;/g, "[")
    .replace(/&#93;/g, "]")
    .replace(/&#44;/g, ",")
    .replace(/&amp;/g, "&")
    .trim();
}

type Pending = { texts: string[]; userName: string; timer: NodeJS.Timeout };
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

  const text = extractText(event);
  if (!text) return "empty message";

  const userName =
    process.env.QQ_USER_NAME || event.sender?.nickname || "你";
  const entry = pending.get(qq);
  if (entry) {
    clearTimeout(entry.timer);
    entry.texts.push(text);
  }
  const next: Pending = entry ?? { texts: [text], userName, timer: undefined as any };
  next.timer = setTimeout(() => {
    pending.delete(qq);
    replyTo(qq, next.userName, next.texts.join("\n")).catch((err) =>
      console.error(`QQ reply to ${qq} failed`, err)
    );
  }, DEBOUNCE_MS);
  pending.set(qq, next);
  return null;
}

async function replyTo(qq: string, userName: string, text: string) {
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

/** Send each line as its own QQ message, with a short "typing" pause between. */
export async function sendInPieces(qq: string, reply: string) {
  const pieces = reply.split(/\n+/).map((s) => s.trim()).filter(Boolean);
  for (let i = 0; i < pieces.length; i++) {
    if (i > 0) await sleep(Math.min(3000, 500 + pieces[i].length * 80));
    await sendPrivateMessage(qq, pieces[i]);
  }
}
