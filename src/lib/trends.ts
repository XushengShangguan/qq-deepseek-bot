import fs from "fs";
import path from "path";
import { getLLM } from "./llm";
import { baiduRealtime, biliComments, biliHotSearch, biliPopular, tiebaHot } from "./web";

// What she has "seen on her phone lately": a few times a day, pull public hot
// lists (Bilibili hot searches, popular videos and their top comments, Baidu
// realtime, Tieba hot topics) and have the model boil them down to current topics and the way
// people are talking. The digest goes into the chat prompt so she can keep up
// with new memes. Refreshes in the background; a turn never waits for it.

const ENABLED = (process.env.TRENDS || "on") !== "off";
const TRENDS_PATH = path.join(path.dirname(process.env.DB_PATH || "data/companion.db"), "trends.json");
const REFRESH_MS = Number(process.env.TRENDS_REFRESH_HOURS || 8) * 3600 * 1000;
// After a failed refresh, wait this long before trying again.
const RETRY_MS = 30 * 60 * 1000;

type Digest = { updatedAt: number; text: string };

async function popularWithComments(): Promise<{ titles: string[]; comments: string[] }> {
  const list = await biliPopular(20);
  const comments: string[] = [];
  // Top comments are where the current slang actually lives.
  for (const v of list.slice(0, 8)) {
    comments.push(...(await biliComments(v.aid).catch(() => [] as string[])).filter((c) => c.length <= 80));
  }
  return { titles: list.map((v) => v.title), comments };
}

const DIGEST_SYSTEM = `你在帮一个聊天角色"刷手机"。她是个很爱上网的年轻人，平时刷 B 站、微博、小红书。
下面是今天网上的热搜、热门视频标题、热门评论和贴吧热议。请整理成她脑子里"最近网上在发生什么"的印象，只输出两部分纯文本，不要 Markdown 加粗：

最近大家在聊的：
- 挑 6~10 个年轻人真的会拿来聊的话题（游戏、动漫、综艺、明星、生活、社会热点、离谱新闻都行），每条一行，用一句大白话说清楚是什么事
- 太严肃的政治外交新闻、灾难事故不要

最近评论区流行的说法：
- 从热门评论和标题里挑 5~10 个现在网上流行的说法、梗或句式，每条一行："说法 —— 什么意思 / 一般什么时候用"
- 只挑真正在用的网络用语，普通句子不要；看不出意思的宁可不写，不要编

素材太少就少写，不要凑数。`;

async function buildDigest(): Promise<string> {
  const [hot, popular, baidu, tieba] = await Promise.allSettled([biliHotSearch(), popularWithComments(), baiduRealtime(), tiebaHot()]);
  const parts: string[] = [];
  if (hot.status === "fulfilled" && hot.value.length) parts.push(`B站热搜：\n${hot.value.join("\n")}`);
  if (popular.status === "fulfilled") {
    if (popular.value.titles.length) parts.push(`B站热门视频标题：\n${popular.value.titles.join("\n")}`);
    if (popular.value.comments.length) parts.push(`B站热门评论：\n${popular.value.comments.join("\n")}`);
  }
  if (baidu.status === "fulfilled" && baidu.value.length) parts.push(`百度热搜：\n${baidu.value.join("\n")}`);
  if (tieba.status === "fulfilled" && tieba.value.length) parts.push(`贴吧热议：\n${tieba.value.join("\n")}`);
  for (const r of [hot, popular, baidu, tieba]) {
    if (r.status === "rejected") console.log("WARNING: trends source failed:", String(r.reason));
  }
  if (!parts.length) throw new Error("no trend sources reachable");

  const llm = await getLLM();
  const text = await llm.generate(DIGEST_SYSTEM, [{ role: "user", content: parts.join("\n\n") }], {
    purpose: "extract",
    json: false,
    maxTokens: 1500,
  });
  return text.replace(/\*\*/g, "").trim();
}

function readDigest(): Digest | null {
  try {
    return JSON.parse(fs.readFileSync(TRENDS_PATH, "utf8"));
  } catch {
    return null;
  }
}

// Next.js dev mode re-evaluates modules; keep refresh state on globalThis.
const state = globalThis as unknown as { trendsRefreshing?: boolean; trendsFailedAt?: number };

export async function refreshTrends(): Promise<Digest> {
  const digest = { updatedAt: Date.now(), text: await buildDigest() };
  fs.mkdirSync(path.dirname(TRENDS_PATH), { recursive: true });
  fs.writeFileSync(TRENDS_PATH, JSON.stringify(digest, null, 2));
  console.log("INFO: trends refreshed\n" + digest.text);
  return digest;
}

/** Latest digest text ("" if none yet); kicks off a background refresh when stale. */
export function getTrends(): string {
  if (!ENABLED) return "";
  const digest = readDigest();
  const stale = !digest || Date.now() - digest.updatedAt > REFRESH_MS;
  const recentlyFailed = state.trendsFailedAt && Date.now() - state.trendsFailedAt < RETRY_MS;
  if (stale && !state.trendsRefreshing && !recentlyFailed) {
    state.trendsRefreshing = true;
    refreshTrends()
      .catch((err) => {
        state.trendsFailedAt = Date.now();
        console.error("trends refresh failed", err);
      })
      .finally(() => {
        state.trendsRefreshing = false;
      });
  }
  return digest?.text ?? "";
}
