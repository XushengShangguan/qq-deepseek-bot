import { lookup } from "dns/promises";
import { isIP } from "net";

// Read-only web access for her free time: read a page, look up a term,
// browse Bilibili. Everything returns plain text, trimmed to keep tokens sane.
// Nothing here can reach this machine or the local network (NapCat's API is on
// localhost), so a page she opens can't be used to poke at the bot.

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36";
const MAX_TEXT = 3000;

export async function getJson(url: string): Promise<any> {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Referer: "https://www.bilibili.com/" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|li|h\d|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

function isPrivateAddress(ip: string): boolean {
  if (ip.includes(":")) {
    const v6 = ip.toLowerCase();
    if (v6.startsWith("::ffff:")) return isPrivateAddress(v6.slice(7));
    return v6 === "::1" || v6 === "::" || v6.startsWith("fc") || v6.startsWith("fd") || v6.startsWith("fe80");
  }
  const [a, b] = ip.split(".").map(Number);
  return (
    a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

async function assertPublicUrl(raw: string): Promise<URL> {
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("只能打开 http/https 网页");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addrs = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
  if (!addrs.length || addrs.some(isPrivateAddress)) throw new Error("这个地址打不开");
  return url;
}

/** Fetch a public page as text. Redirects are followed by hand so each hop is checked. */
export async function readPage(raw: string): Promise<string> {
  let url = await assertPublicUrl(raw);
  for (let hop = 0; hop < 4; hop++) {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, "Accept-Language": "zh-CN,zh;q=0.9" },
      redirect: "manual",
      signal: AbortSignal.timeout(12_000),
    });
    const next = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && next) {
      url = await assertPublicUrl(new URL(next, url).toString());
      continue;
    }
    if (!res.ok) throw new Error(`打不开（HTTP ${res.status}）`);
    const type = res.headers.get("content-type") || "";
    if (!/text|json|xml/.test(type)) throw new Error(`不是网页（${type}）`);
    const text = htmlToText(await res.text());
    return text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) + "…（后面省略）" : text;
  }
  throw new Error("跳转太多次");
}

/** Baidu Baike summary for a term. */
export async function lookupBaike(term: string): Promise<string> {
  const d = await getJson(
    `https://baike.baidu.com/api/openapi/BaikeLemmaCardApi?scope=103&format=json&appid=379020&bk_key=${encodeURIComponent(term)}&bk_length=600`
  );
  if (!d?.abstract && !d?.desc) return "百科里没有这个词";
  return `${d.title ?? term}：${d.desc ?? ""}\n${d.abstract ?? ""}`.trim();
}

export async function biliHotSearch(): Promise<string[]> {
  const d = await getJson("https://s.search.bilibili.com/main/hotword");
  return (d.list ?? []).map((x: any) => x.keyword).filter(Boolean);
}

export async function biliPopular(n = 20): Promise<{ aid: number; bvid: string; title: string }[]> {
  const d = await getJson(`https://api.bilibili.com/x/web-interface/popular?ps=${n}`);
  return (d.data?.list ?? []).map((v: any) => ({ aid: v.aid, bvid: v.bvid, title: v.title }));
}

export async function biliComments(aid: number, n = 10): Promise<string[]> {
  const r = await getJson(`https://api.bilibili.com/x/v2/reply?type=1&oid=${aid}&sort=1&ps=${n}`);
  return (r.data?.replies ?? [])
    .map((c: any) => String(c.content?.message ?? "").replace(/\s+/g, " ").trim())
    .filter((t: string) => t && t.length <= 120);
}

// Bilibili's BV id is a reversible encoding of the numeric av id.
const BV_ALPHABET = "FcwAPNKTMug3GV5Lj7EJnHpWsx4tb8haYeviqBz6rkCy12mUSDQX9RdoZf";

function bvToAv(bvid: string): string {
  const c = bvid.split("");
  [c[3], c[9]] = [c[9], c[3]];
  [c[4], c[7]] = [c[7], c[4]];
  let n = BigInt(0);
  for (const ch of c.slice(3)) n = n * BigInt(58) + BigInt(BV_ALPHABET.indexOf(ch));
  return String((n & BigInt("2251799813685247")) ^ BigInt("23442827791579"));
}

/**
 * A Bilibili video's description and top comments, by BV id, av id or link.
 * (The full video-info API wants a logged-in browser; these two don't.)
 */
export async function biliVideo(ref: string): Promise<string> {
  const bvid = ref.match(/BV[0-9A-Za-z]{10}/)?.[0];
  const aid = bvid ? bvToAv(bvid) : ref.match(/av(\d+)/i)?.[1] ?? (/^\d+$/.test(ref.trim()) ? ref.trim() : undefined);
  if (!aid) throw new Error("需要 BV 号、av 号或视频链接");
  const [desc, comments] = await Promise.all([
    getJson(`https://api.bilibili.com/x/web-interface/archive/desc?aid=${aid}`)
      .then((d) => String(d.data ?? ""))
      .catch(() => ""),
    biliComments(Number(aid)).catch(() => [] as string[]),
  ]);
  if (!desc && !comments.length) throw new Error("找不到这个视频");
  return [
    desc ? `简介：${desc.slice(0, 300)}` : "",
    comments.length ? `热门评论：\n${comments.map((c) => `- ${c}`).join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export async function baiduRealtime(): Promise<string[]> {
  const d = await getJson("https://top.baidu.com/api/board?tab=realtime");
  return (d.data?.cards?.[0]?.content ?? []).map((x: any) => x.word).filter(Boolean).slice(0, 20);
}

// ---------- Baidu Tieba (mobile web JSON; no login needed) ----------

function tiebaText(content: any[] = []): string {
  return content
    .map((c) => (typeof c?.text === "string" ? c.text : ""))
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

/** Tieba's hot-discussion board: topic titles. */
export async function tiebaHot(): Promise<string[]> {
  const res = await fetch("https://tieba.baidu.com/hottopic/browse/topicList?res_type=1", {
    headers: { "User-Agent": UA },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`贴吧热议打不开（HTTP ${res.status}）`);
  const html = await res.text();
  return Array.from(html.matchAll(/class="topic-text">([^<]+)</g), (m) => htmlToText(m[1])).slice(0, 20);
}

/** Recent threads in one tieba (贴吧), e.g. "deepseek". */
export async function tiebaForum(name: string): Promise<string> {
  const d = await getJson(
    `https://tieba.baidu.com/mg/f/getFrsData?kw=${encodeURIComponent(name)}&rn=15&pn=1&sort_type=0`
  );
  const threads: any[] = d.data?.thread_list ?? [];
  if (!d.data?.forum?.is_exists && !threads.length) return `没有"${name}"这个吧`;
  return threads
    .map((t) => {
      const abstract = tiebaText(t.abstract ?? t.rich_abstract).slice(0, 80);
      return `- ${t.title}（${t.reply_num ?? 0} 回复，帖子号 ${t.id ?? t.tid}）${abstract ? `：${abstract}` : ""}`;
    })
    .join("\n");
}

/** First floors of a tieba thread, by thread id (帖子号) or link. */
export async function tiebaThread(ref: string): Promise<string> {
  const id = ref.match(/(\d{6,})/)?.[1];
  if (!id) throw new Error("需要帖子号或帖子链接");
  const d = await getJson(`https://tieba.baidu.com/mg/p/getPbData?kz=${id}&pn=1&rn=20&obj_param2=chrome`);
  const posts: any[] = d.data?.post_list ?? [];
  if (!posts.length) throw new Error("帖子打不开或已被删");
  const title = d.data?.thread?.title ?? posts[0]?.title ?? "";
  const floors = posts
    .map((p) => ({ floor: Number(p.floor), text: tiebaText(p.content) }))
    .filter((p) => p.text)
    .map((p) => `${p.floor === 1 ? "楼主" : `${p.floor}楼`}：${p.text.slice(0, 150)}`);
  return [title ? `标题：${title}` : "", ...floors].filter(Boolean).join("\n");
}
