import { createHash, createHmac } from "crypto";
import fs from "fs";
import path from "path";

// 小黑盒 (xiaoheihe.cn) through the site's own web API, logged in as her own
// account: browse the feed, search a game, open a post, and comment. There is
// no official API; every request carries an `hkey` signature reproduced from
// the web client (after Insect-rippler/XIAOHEIHE_MCP, MIT), so a site update
// can break this until the signing is updated.
//
// The login cookies (user_pkey, user_heybox_id, heybox_id, x_xhh_tokenid) are
// kept in data/heybox.json, written by scripts/heybox-login.ts. Without that
// file the tools say so and nothing is sent.

const API = "https://api.xiaoheihe.cn";
const WORKSHOP_API = "https://workshopapi.xiaoheihe.cn";
const COOKIE_FILE =
  process.env.HEYBOX_COOKIE_FILE || path.join(path.dirname(process.env.DB_PATH || "data/companion.db"), "heybox.json");
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

// ---------- signing ----------

const ALPHABET = "AB45STUVWZEFGJ6CH01D237IXYPQRKLMN89";
// Comment writes go to the workshop API and also carry `_rnd`.
const RND_VERSION = "15";
const RND_SECRET = "Z7mFG4tQp9Ws2LxB8H";

const md5 = (s: string) => createHash("md5").update(s, "utf8").digest("hex");
const project = (s: string, table: string) => Array.from(s, (c) => table[c.charCodeAt(0) % table.length]).join("");

function interleave(parts: string[]): string {
  let out = "";
  for (let i = 0; i < Math.max(...parts.map((p) => p.length)); i++) for (const p of parts) if (i < p.length) out += p[i];
  return out;
}

// AES-style column mix over the last hash bytes.
const xtime = (v: number) => (v & 0x80 ? ((v << 1) ^ 0x1b) & 0xff : (v << 1) & 0xff);
const m3 = (v: number) => xtime(v) ^ v;
const m4 = (v: number) => m3(xtime(v));
const m8 = (v: number) => m4(m3(xtime(v)));
const m14 = (v: number) => m8(v) ^ m4(v) ^ m3(v);

export function heyboxSign(apiPath: string, nowMs = Date.now()): { hkey: string; _time: number; nonce: string } {
  const time = Math.floor(nowMs / 1000);
  const nonce = md5(`${time}${Math.random()}`).toUpperCase();
  const stem = interleave([
    project(String(time + 1), ALPHABET.slice(0, -2)),
    project(`/${apiPath.split("/").filter(Boolean).join("/")}/`, ALPHABET),
    project(nonce, ALPHABET),
  ]).slice(0, 20);
  const hash = md5(stem);
  const [a, b, c, d, e, f] = Array.from(hash.slice(-6), (ch) => ch.charCodeAt(0));
  const sum =
    (m14(a) ^ m8(b) ^ m4(c) ^ m3(d)) +
    (m3(a) ^ m14(b) ^ m8(c) ^ m4(d)) +
    (m4(a) ^ m3(b) ^ m14(c) ^ m8(d)) +
    (m8(a) ^ m4(b) ^ m3(c) ^ m14(d)) +
    e +
    f;
  return { hkey: project(hash.slice(0, 5), ALPHABET.slice(0, -4)) + String(sum % 100).padStart(2, "0"), _time: time, nonce };
}

function rnd(nonce: string, time: number): string {
  const hex = createHmac("sha256", RND_SECRET).update(`${RND_SECRET}${nonce}${time}:${nonce}`, "utf8").digest("hex");
  return `${RND_VERSION}:${hex}`;
}

// ---------- transport ----------

type Cookies = Record<string, string>;

function loadCookies(): Cookies | null {
  try {
    const j = JSON.parse(fs.readFileSync(COOKIE_FILE, "utf8"));
    return j.cookie?.user_pkey ? (j.cookie as Cookies) : null;
  } catch {
    return null;
  }
}

export function heyboxLoggedIn(): boolean {
  return loadCookies() !== null;
}

/** An error she can be told about as-is. */
export class HeyboxError extends Error {
  constructor(message: string, readonly kind: "login" | "captcha" | "rejected" | "other" = "other") {
    super(message);
  }
}

async function call(
  method: "GET" | "POST",
  apiPath: string,
  opts: {
    query?: Record<string, string | number>;
    form?: Record<string, string | number>;
    workshop?: boolean;
    webVersion?: "2.5" | "3.0";
  } = {}
): Promise<any> {
  const cookies = loadCookies();
  if (!cookies) throw new HeyboxError("小黑盒还没登录", "login");
  const s = heyboxSign(apiPath);
  const params: Record<string, string> = {
    os_type: "web",
    app: "heybox",
    client_type: "web",
    version: "999.0.4",
    web_version: opts.webVersion ?? (opts.workshop ? "3.0" : "2.5"),
    x_client_type: "web",
    x_app: "heybox_website",
    heybox_id: cookies.heybox_id || cookies.user_heybox_id || "",
    x_os_type: "Windows",
    device_info: "Chrome",
    hkey: s.hkey,
    _time: String(s._time),
    nonce: s.nonce,
  };
  for (const [k, v] of Object.entries(opts.query ?? {})) params[k] = String(v);
  if (opts.workshop) {
    params.x_client_version = "";
    params._rnd = rnd(s.nonce, s._time);
  }
  let qs = new URLSearchParams(params).toString();
  // The post-detail endpoint wants a bare h_src marker right before link_id.
  if (apiPath === "/bbs/app/link/tree") qs = qs.replace("&link_id=", "&h_src&link_id=");

  const headers: Record<string, string> = {
    "User-Agent": UA,
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9",
    Origin: "https://www.xiaoheihe.cn",
    Referer: "https://www.xiaoheihe.cn/",
    Cookie: Object.entries(cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join("; "),
  };
  let body: string | undefined;
  if (method === "POST") {
    headers["Content-Type"] = "application/x-www-form-urlencoded;charset=utf-8";
    body = new URLSearchParams(Object.entries(opts.form ?? {}).map(([k, v]) => [k, String(v)])).toString();
  }
  const res = await fetch(`${opts.workshop ? WORKSHOP_API : API}${apiPath}?${qs}`, {
    method,
    headers,
    body,
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 401 || res.status === 403) throw new HeyboxError("小黑盒登录过期了", "login");
  const text = await res.text();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    throw new HeyboxError(`小黑盒打不开（HTTP ${res.status}）`);
  }
  if (data.status !== "ok") {
    const msg = String(data.msg ?? data.error ?? "");
    const all = `${data.status} ${msg}`.toLowerCase();
    if (/captcha|验证/.test(all)) throw new HeyboxError("小黑盒要人机验证，先别发了", "captcha");
    if (/登录|login|relogin/.test(all)) throw new HeyboxError("小黑盒登录过期了", "login");
    if (/审核|违规|敏感|sensitive/.test(all)) throw new HeyboxError(`被小黑盒拦了：${msg}`, "rejected");
    throw new HeyboxError(`小黑盒说：${msg || data.status}`);
  }
  return data;
}

// ---------- text ----------

function stripHtml(s: string): string {
  return s
    .replace(/<br\s*\/?>|<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&amp;/gi, "&")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

/** A post body is HTML or a JSON list of text / img segments. */
function richText(raw: unknown): { text: string; images: string[] } {
  if (typeof raw !== "string" || !raw.trim()) return { text: "", images: [] };
  const images: string[] = [];
  const imgTags = (html: string) => {
    for (const m of Array.from(html.matchAll(/<img[^>]+(?:data-original|src)=["']([^"']+)["']/gi))) images.push(m[1]);
  };
  let text = "";
  try {
    const parts = JSON.parse(raw);
    if (!Array.isArray(parts)) throw new Error();
    text = parts
      .map((p: any) => {
        // An image segment's text is the uploader's local file path.
        if (p?.type === "img") {
          if (p.url) images.push(p.url);
          return "";
        }
        if (typeof p?.text === "string") {
          imgTags(p.text);
          return stripHtml(p.text);
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  } catch {
    imgTags(raw);
    text = stripHtml(raw);
  }
  return { text, images: Array.from(new Set(images)).filter((u) => /^https?:/.test(u)) };
}

function linkLine(l: any): string | null {
  const id = l.linkid ?? l.link_id;
  if (!id) return null;
  const title = stripHtml(String(l.title ?? ""));
  const preview = (richText(l.text).text || stripHtml(String(l.description ?? ""))).replace(/\s+/g, " ").slice(0, 80);
  const who = l.user?.username ? `${l.user.username}，` : "";
  return `- ${title || "（无标题）"}（${who}${l.link_award_num ?? l.up ?? 0} 赞 ${l.comment_num ?? 0} 评论，帖子号 ${id}）${preview ? `：${preview}` : ""}`;
}

// ---------- what she can do ----------

/** The account's home feed (recommendations plus what it follows). */
export async function heyboxFeed(): Promise<string> {
  const d = await call("GET", "/bbs/app/feeds", { query: { offset: 0, pull: 0, limit: 15 } });
  const lines = ((d.result?.links ?? []) as any[]).map(linkLine).filter(Boolean);
  return lines.join("\n") || "首页是空的";
}

/** Posts about a game or anything else, by keyword. */
export async function heyboxSearch(keyword: string): Promise<string> {
  if (!keyword.trim()) throw new HeyboxError("要搜什么？");
  const d = await call("GET", "/bbs/app/api/general/search/v1", {
    query: { q: keyword, search_type: "general", is_pull_down: 0, offset: 0, limit: 30, dw: 628 },
  });
  const lines = ((d.result?.items ?? []) as any[])
    .filter((i) => i?.type === "link")
    .map((i) => linkLine(i.info ?? {}))
    .filter(Boolean)
    .slice(0, 12);
  return lines.join("\n") || `没搜到"${keyword}"相关的帖子`;
}

export function heyboxPostId(ref: string): string | null {
  return ref.match(/link\/(\d+)/)?.[1] ?? ref.match(/link_id=(\d+)/)?.[1] ?? ref.match(/^\s*(\d{4,})\s*$/)?.[1] ?? null;
}

/** A post with its first comments; comment ids are shown so she can reply to one. */
export async function heyboxPost(ref: string): Promise<string> {
  const id = heyboxPostId(ref);
  if (!id) throw new HeyboxError("需要帖子号或帖子链接");
  const d = await call("GET", "/bbs/app/link/tree", {
    query: { link_id: id, is_first: 1, page: 1, index: 1, limit: 20, owner_only: 0 },
  });
  const link = d.result?.link ?? {};
  const body = richText(link.text);
  const comments: string[] = [];
  for (const group of (d.result?.comments ?? []) as any[]) {
    const list = Array.isArray(group?.comment) ? group.comment : [group];
    // A group is one floor: its first comment, then replies inside it.
    const root = String(list[0]?.commentid ?? "");
    for (const c of list) {
      if (!c?.commentid) continue;
      rememberRoot(String(c.commentid), root);
      if (c.is_cy === 1) continue;
      const text = stripHtml(String(c.text ?? ""));
      const pics = ((c.imgs ?? []) as any[])
        .map((i) => (typeof i === "string" ? i : i?.url))
        .filter((u) => /^https?:/.test(String(u)))
        .map((u) => `[图片 ${u}]`)
        .join(" ");
      if (!text && !pics) continue;
      const reply = c.replyuser?.username ? `回复${c.replyuser.username}：` : "";
      comments.push(
        `- ${c.user?.username ?? "某人"}${c.is_link_owner === 1 ? "（楼主）" : ""}：${reply}${text.replace(/\s+/g, " ").slice(0, 150)} ${pics}（${
          c.up ?? 0
        } 赞，评论号 ${c.commentid}）`.replace(/\s+（/, "（")
      );
    }
  }
  return [
    `标题：${stripHtml(String(link.title ?? "")) || "（无标题）"}`,
    link.user?.username ? `作者：${link.user.username}` : "",
    body.text ? `正文：${body.text.slice(0, 1500)}` : "",
    body.images.length ? body.images.slice(0, 6).map((u) => `[图片 ${u}]`).join(" ") : "",
    comments.length ? `评论：\n${comments.slice(0, 20).join("\n")}` : "还没有评论",
  ]
    .filter(Boolean)
    .join("\n");
}

// Which floor (top-level comment) each comment she has seen sits in: a reply
// needs both the comment it answers (reply_id) and its floor (root_id).
const roots = new Map<string, string>();
function rememberRoot(comment: string, root: string) {
  if (roots.size > 2000) roots.clear();
  if (root) roots.set(comment, root);
}

/** Comment on a post, or reply to one of its comments. Returns the new comment id. */
export async function heyboxComment(postRef: string, text: string, replyTo?: string): Promise<string> {
  const id = heyboxPostId(postRef);
  if (!id) throw new HeyboxError("需要帖子号或帖子链接");
  const reply = replyTo?.match(/\d+/)?.[0];
  const d = await call("POST", "/bbs/app/comment/create", {
    workshop: true,
    // A reply to a top-level comment has that comment as its own floor.
    form: { is_cy: 0, link_id: id, reply_id: reply ?? -1, root_id: reply ? roots.get(reply) ?? reply : -1, text },
  });
  return String(d.commentid ?? d.result?.commentid ?? "");
}

/** People replying to her or commenting on her posts, newest first. */
export async function heyboxInbox(): Promise<{ text: string; unread: number }> {
  const d = await call("GET", "/bbs/app/user/message", { query: { list_type: 0, offset: 0, limit: 15, no_more: "false" } });
  const unread = Number(d.result?.message_unread_num ?? 0);
  const lines = ((d.result?.messages ?? []) as any[])
    .filter((m) => m?.comment_a_id && m.comment_a_is_cy !== "1")
    .map((m) => {
      rememberRoot(String(m.comment_a_id), String(m.root_comment_id ?? m.comment_a_id));
      const who = m.user_a?.username ?? "有人";
      const yours = m.comment_b_text ? `（回的是你说的：「${stripHtml(String(m.comment_b_text)).slice(0, 40)}」）` : "（评论了你的帖子）";
      return `- ${who}在《${stripHtml(String(m.link_title ?? ""))}》里说：「${stripHtml(String(m.comment_a_text ?? "")).replace(/\s+/g, " ").slice(0, 150)}」${yours}——帖子号 ${m.linkid}，评论号 ${m.comment_a_id}`;
    });
  return { text: lines.join("\n") || "还没人回你", unread };
}

// 盒友杂谈, where her own posts go.
const POST_TOPIC = Number(process.env.HEYBOX_POST_TOPIC || 7214);
const TITLE_MAX = 30;

/** Publish a text post in her community. Returns the new post id. */
export async function heyboxPublish(title: string, body: string): Promise<string> {
  title = title.trim();
  body = body.trim();
  if (!title || !body) throw new HeyboxError("标题和正文都要有");
  if (title.length > TITLE_MAX) throw new HeyboxError(`标题最多 ${TITLE_MAX} 个字`);
  const d = await call("POST", "/bbs/app/api/link/post", {
    webVersion: "3.0",
    form: {
      link_tag: 27,
      text: JSON.stringify([{ type: "text", text: body }]),
      title,
      desc: body.slice(0, 100),
      words_count: body.length,
      topic_ids: POST_TOPIC,
      hashtags: "[]",
      schedule_ts: 0,
      view_limit: 1,
      post_type: 1,
      original: 1,
      declaration: 0,
    },
  });
  return String(d.link_id ?? d.result?.link_id ?? "");
}
