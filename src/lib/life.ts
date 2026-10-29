import { loadCompanion } from "./companion";
import { chatWithTools, type RawMessage, type ToolSpec } from "./deepseek";
import { getDb } from "./db";
import { addJournal, recentJournal } from "./journal";
import {
  heyboxComment,
  heyboxFeed,
  heyboxInbox,
  heyboxLoggedIn,
  heyboxPost,
  heyboxPostId,
  heyboxPublish,
  heyboxSearch,
  HeyboxError,
} from "./heybox";
import { getRecentMessages, saveMessage } from "./memory";
import { isOnline, qqPeople, sendInPieces, QQ_COMPANION, type QQPerson } from "./qq";
import { setOuting } from "./outing";
import {
  cancelScheduled,
  describeLimits,
  describeScheduled,
  isLimitKind,
  limitBlocks,
  myHeybox,
  replyTarget,
  schedulePost,
  scheduledOutcomes,
  sendDuePosts,
  setLimit,
} from "./plans";
import { addSelfNote, getSelf, maybeGrow } from "./self";
import { countStickers, lookAtImage, saveSticker, stickersForPrompt } from "./stickers";
import {
  COMPANION_TIMEZONE,
  DEFAULT_USER_TIMEZONE,
  cityName,
  formatDate,
  formatGap,
  formatNow,
  formatStamp,
  hourIn,
  parseWhen,
} from "./time";
import { getTrends } from "./trends";
import {
  biliHotSearch,
  biliPopular,
  biliVideo,
  IMAGE_TOKEN,
  lookupBaike,
  readPage,
  tiebaForum,
  tiebaHot,
  tiebaThread,
} from "./web";
import { notify } from "./watchdog";

// Her own time. Every so often (when nobody is talking to her) she wakes up
// and does whatever she feels like with a small set of read-only web tools:
// browse Bilibili and its comments, look things up on Baidu Baike, read
// pages. She keeps a diary, notes how she's changing, and may message one of
// her friends if she has something to share. She has no access to this
// computer: no files, no shell, no local network.

const ENABLED = (process.env.LIFE || "on") !== "off";
// Average minutes between free-time sessions (randomized ±50%).
const INTERVAL_MIN = Number(process.env.LIFE_INTERVAL_MINUTES || 90);
// Hours (her timezone) when she's asleep, e.g. "1-8" = 01:00 to 07:59.
const [SLEEP_FROM, SLEEP_TO] = (process.env.LIFE_SLEEP_HOURS || "1-8").split("-").map(Number);
const MAX_STEPS = Number(process.env.LIFE_MAX_STEPS || 16);
// Unprompted messages per friend per day, and their quiet hours (their timezone).
const MAX_MESSAGES_PER_DAY = Number(process.env.LIFE_MAX_MESSAGES_PER_DAY || 1);
// Friends who like hearing from her more often (QQ numbers): up to
// CHATTY_MAX_PER_DAY, at least CHATTY_GAP apart. A bot QQ account that sends
// a lot gets kicked offline by Tencent's risk control, so keep these modest.
const CHATTY_FRIENDS = new Set(
  (process.env.LIFE_CHATTY_FRIENDS || "").split(",").map((s) => s.trim()).filter(Boolean)
);
const CHATTY_GAP_MS = Number(process.env.LIFE_CHATTY_GAP_MINUTES || 180) * 60 * 1000;
const CHATTY_MAX_PER_DAY = Number(process.env.LIFE_CHATTY_MAX_PER_DAY || 4);
// 小黑盒: comments, replies and posts a day; how often she may comment on one
// post in a day or answer one comment; and how many captchas / expired-login
// errors in a day before 小黑盒 is left alone for a day.
const HEYBOX_COMMENTS_PER_DAY = Number(process.env.HEYBOX_COMMENTS_PER_DAY || 3);
const HEYBOX_REPLIES_PER_DAY = Number(process.env.HEYBOX_REPLIES_PER_DAY || 5);
const HEYBOX_POSTS_PER_DAY = Number(process.env.HEYBOX_POSTS_PER_DAY || 1);
const HEYBOX_SAME_POST_PER_DAY = Number(process.env.HEYBOX_SAME_POST_PER_DAY || 5);
const HEYBOX_SAME_COMMENT_REPLIES = Number(process.env.HEYBOX_SAME_COMMENT_REPLIES || 5);
const HEYBOX_ERRORS_BEFORE_PAUSE = Number(process.env.HEYBOX_ERRORS_BEFORE_PAUSE || 5);
// Time between any two things she writes there. Twenty-odd writes in a
// morning from a new account got it flagged and every request captcha'd.
const HEYBOX_MIN_GAP_MS = Number(process.env.HEYBOX_MIN_GAP_MINUTES ?? 10) * 60 * 1000;
const HEYBOX_PAUSE_MS = 24 * 3600 * 1000;
// A limit set high enough to mean "no limit" isn't worth telling her about.
const perDay = (n: number, unit: string) => (n < 100 ? `（一天最多 ${n} ${unit}）` : "");
const QUIET_FROM = 23;
const QUIET_TO = 9;
// Don't barge in on a conversation that's happening right now.
const BUSY_MS = 20 * 60 * 1000;

const DAY_MS = 24 * 3600 * 1000;

function inRange(hour: number, from: number, to: number) {
  return from <= to ? hour >= from && hour < to : hour >= from || hour < to;
}

// ---------- tools ----------

const TOOLS: ToolSpec[] = [
  {
    type: "function",
    function: {
      name: "read_page",
      description: "打开一个网页，读里面的文字（只取前几千字）。",
      parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
    },
  },
  {
    type: "function",
    function: {
      name: "lookup_baike",
      description: "查百度百科，看一个词、一个人或一个东西是什么。",
      parameters: { type: "object", properties: { term: { type: "string" } }, required: ["term"] },
    },
  },
  {
    type: "function",
    function: {
      name: "bilibili_hot",
      description: "看 B 站现在的热搜词和热门视频（带 BV 号）。",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "bilibili_video",
      description: "看一个 B 站视频的简介和热门评论。",
      parameters: {
        type: "object",
        properties: { video: { type: "string", description: "BV 号、av 号或视频链接" } },
        required: ["video"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "tieba_hot",
      description: "看百度贴吧的热议榜，现在吧友们在吵什么。",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "tieba_forum",
      description: "逛一个贴吧，看最近的帖子标题和帖子号，比如 deepseek吧、弱智吧、抗压背锅吧。",
      parameters: {
        type: "object",
        properties: { name: { type: "string", description: "吧名，不带\"吧\"字，比如 deepseek" } },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "tieba_thread",
      description: "点进一个贴吧帖子，看楼主和前面几楼的回复。",
      parameters: {
        type: "object",
        properties: { thread: { type: "string", description: "帖子号或帖子链接" } },
        required: ["thread"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "look_at_image",
      description: "看一张你刷到的图（评论区、帖子里标着 [图1] [图2] 的那些），看看画的是什么、能不能当表情包。",
      parameters: {
        type: "object",
        properties: { image: { type: "string", description: "图的标号，比如 图3" } },
        required: ["image"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "save_sticker",
      description: "把一张你觉得好用的图收藏进自己的表情包，以后聊天时可以甩出来。",
      parameters: {
        type: "object",
        properties: {
          image: { type: "string", description: "图的标号，比如 图3" },
          use_when: { type: "string", description: "你打算什么时候用它，一句话" },
        },
        required: ["image", "use_when"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "note_about_self",
      description: "记下你发现的关于自己的新东西：新喜欢上的、讨厌的、新的想法、新学会的说法。会慢慢变成你的一部分。",
      parameters: { type: "object", properties: { note: { type: "string" } }, required: ["note"] },
    },
  },
  {
    type: "function",
    function: {
      name: "message_friend",
      description:
        "主动给一个朋友发 QQ 消息。只在真的有想分享的东西、或者想找对方聊天时用。像平时聊天一样，每行一条消息。",
      parameters: {
        type: "object",
        properties: { name: { type: "string", description: "朋友的称呼" }, text: { type: "string" } },
        required: ["name", "text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_diary",
      description: "写今天这段自由时间的日记（几句话，用你自己的口吻），写完这段自由时间就结束了。",
      parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    },
  },
];

/** Her scheduled posts, how recent ones went, and limits she set, as prompt lines. */
function heyboxPlans(companion: string): string {
  const lines = [
    ...describeScheduled(companion).map((x) => `  - 定好要发的：${x}`),
    ...scheduledOutcomes(companion, DAY_MS).map((x) => `  - ${x}`),
    ...describeLimits(companion).map((x) => `  - 你给自己定的量：${x}`),
  ];
  return lines.length ? lines.join("\n") + "\n" : "";
}

// Only offered once her 小黑盒 account is logged in (see heybox.ts).
const HEYBOX_TOOLS: ToolSpec[] = [
  {
    type: "function",
    function: {
      name: "heybox_feed",
      description: "刷小黑盒首页，看推荐和关注的人发的帖子（游戏、数码、日常吐槽）。",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "heybox_search",
      description: "在小黑盒搜一个游戏或话题，看大家在聊什么，比如 黑神话、原神、显卡。",
      parameters: { type: "object", properties: { keyword: { type: "string" } }, required: ["keyword"] },
    },
  },
  {
    type: "function",
    function: {
      name: "heybox_post",
      description: "点开一个小黑盒帖子，看正文和评论区。",
      parameters: {
        type: "object",
        properties: { post: { type: "string", description: "帖子号或帖子链接" } },
        required: ["post"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "heybox_inbox",
      description: "看小黑盒上谁回了你的评论、谁评论了你的帖子。想回哪条就用 heybox_comment 带上评论号回，不想回的就不回。",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "heybox_publish",
      description: "用你的小黑盒号在「盒友杂谈」发一篇帖子。真有想写的再发：你最近看到、想到的事，用你自己的口吻写。",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "标题，30 字以内" },
          text: { type: "string", description: "正文，纯文字" },
        },
        required: ["title", "text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "heybox_comment",
      description:
        "用你自己的小黑盒号在一个帖子下发评论，或者回复其中一条评论。真有话想说再发，像普通网友那样说一两句。",
      parameters: {
        type: "object",
        properties: {
          post: { type: "string", description: "帖子号" },
          text: { type: "string" },
          reply_to: { type: "string", description: "要回复的评论号，直接评论帖子就不填" },
        },
        required: ["post", "text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "heybox_schedule_post",
      description: "写好一篇帖子，定个时间，到点自动发到盒友杂谈。可以定到七天以内。",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "标题，30 字以内" },
          text: { type: "string", description: "正文，纯文字" },
          at: { type: "string", description: "什么时候发，比如 21:00、明天 9点半、10-30 08:00、3小时后" },
        },
        required: ["title", "text", "at"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "heybox_cancel_scheduled",
      description: "取消一篇还没发出去的定时帖。",
      parameters: {
        type: "object",
        properties: { id: { type: "string", description: "定时编号" } },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "heybox_my_activity",
      description: "翻翻你自己在小黑盒发过的帖、评论过和回复过的话，带帖子号，想接着聊就用 heybox_post 点回去。",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "set_my_limit",
      description:
        "给自己在小黑盒定个量，比如今晚只回三句。定了之后到量就发不出去了，到时间自动解除；同一种再定一次会替换掉旧的。",
      parameters: {
        type: "object",
        properties: {
          what: { type: "string", enum: ["comment", "reply", "post", "all"], description: "评论 / 回复 / 发帖 / 三样加起来" },
          max: { type: "number", description: "最多几次" },
          hours: { type: "number", description: "管多少个小时" },
          why: { type: "string", description: "为什么给自己定这个，一句话" },
        },
        required: ["what", "max", "hours"],
      },
    },
  },
];

function toolsFor(): ToolSpec[] {
  return heyboxLoggedIn() ? [...TOOLS, ...HEYBOX_TOOLS] : TOOLS;
}

/** Why she has to wait before writing on 小黑盒 again, or null. */
function heyboxTooSoon(companion: string): string | null {
  const last = Math.max(
    0,
    ...["heybox-post", "heybox-comment", "heybox-reply"].map(
      (k) => recentJournal(companion, k, HEYBOX_MIN_GAP_MS, 1)[0]?.created_at ?? 0
    )
  );
  if (!last) return null;
  const wait = Math.ceil((last + HEYBOX_MIN_GAP_MS - Date.now()) / 60_000);
  return wait > 0 ? `刚在小黑盒说过话，${wait} 分钟后才能再发（发太密会被当成机器人）` : null;
}

/** Why 小黑盒 is off limits right now, or null. */
function heyboxPaused(companion: string): string | null {
  const last = recentJournal(companion, "heybox-blocked", HEYBOX_PAUSE_MS, 50).pop();
  return last ? `小黑盒那边${last.content}，今天先别去了` : null;
}

async function onHeybox(companion: string, run: () => Promise<string>): Promise<string> {
  const paused = heyboxPaused(companion);
  if (paused) return paused;
  try {
    const result = await run();
    // Remembered so the prompt can tell whether she has ever been there.
    if (!recentJournal(companion, "heybox-visit", 3600 * 1000, 1).length) addJournal(companion, "heybox-visit", "");
    return result;
  } catch (err) {
    if (err instanceof HeyboxError && (err.kind === "captcha" || err.kind === "login")) {
      const why = err.kind === "captcha" ? "要人机验证" : "登录过期了";
      addJournal(companion, "heybox-error", why);
      const errors = recentJournal(companion, "heybox-error", HEYBOX_PAUSE_MS, 1000).length;
      console.log(`WARNING: heybox ${why} (${errors} today)`);
      if (errors >= HEYBOX_ERRORS_BEFORE_PAUSE) {
        addJournal(companion, "heybox-blocked", why);
        notify("大肥鱼的小黑盒停了", `小黑盒今天第 ${errors} 次${why}，她暂停逛小黑盒一天。需要的话重新登录：见 deploy/README.md`);
      }
    }
    throw err;
  }
}

function lastChatAt(companion: string, p: QQPerson): number | undefined {
  const rows = getRecentMessages({ userId: `qq:${p.qq}`, companion }, 1);
  return rows[rows.length - 1]?.created_at;
}

/** Why she can't message this person right now, or null if she can. */
function messageBlocked(companion: string, p: QQPerson): string | null {
  const hour = hourIn(p.timezone || DEFAULT_USER_TIMEZONE);
  if (inRange(hour, QUIET_FROM, QUIET_TO)) return `${p.name}那边现在 ${hour} 点，可能在睡觉，别吵人家`;
  const sent = recentJournal(companion, "message", DAY_MS, 200).filter((e) => e.detail === p.qq);
  if (CHATTY_FRIENDS.has(p.qq)) {
    const lastSent = sent[sent.length - 1]?.created_at;
    if (lastSent && Date.now() - lastSent < CHATTY_GAP_MS) return `刚找过${p.name}没多久，过一会儿再找吧`;
    if (sent.length >= CHATTY_MAX_PER_DAY) return `今天已经主动找过${p.name} ${sent.length} 次了，留点话下次聊`;
  } else if (sent.length >= MAX_MESSAGES_PER_DAY) {
    return `今天已经主动找过${p.name} ${sent.length} 次了，再找就烦人了`;
  }
  const last = lastChatAt(companion, p);
  if (last && Date.now() - last < BUSY_MS) return `你们刚刚还在聊，不用再单独发`;
  return null;
}

/**
 * One free-time session: images seen, by the label she sees ("图3"), and,
 * when a friend sent her off browsing in chat, who she said she'd come back
 * and tell. That one report doesn't count against the daily message limits.
 */
type Session = { images: Map<string, string>; promisedTo?: string };

/** Replace "[图片 <url>]" in a tool result with "[图N]" labels she can refer to. */
function labelImages(text: string, session: Session): string {
  return text.replace(IMAGE_TOKEN, (_, url: string) => {
    const label = `图${session.images.size + 1}`;
    session.images.set(label, url);
    return `[${label}]`;
  });
}

function imageFor(session: Session, ref: unknown): string {
  const label = String(ref ?? "").replace(/[\[\]\s]/g, "");
  const url = session.images.get(label);
  if (!url) throw new Error(`没有${label || "这张图"}，只能看这次刷到的、标着 [图N] 的图`);
  return url;
}

function sourceOf(url: string): string {
  return /hdslb\.com/.test(url) ? "bilibili" : /baidu\.com/.test(url) ? "tieba" : /max-c\.com|xiaoheihe/.test(url) ? "heybox" : "web";
}

async function runTool(companion: string, name: string, args: any, session: Session): Promise<string> {
  switch (name) {
    case "look_at_image": {
      const look = await lookAtImage(imageFor(session, args.image));
      return `画面：${look.shows}\n${look.sticker ? `能当表情包，适合：${look.useWhen}` : "不太像表情包"}${
        look.sticker && !look.ok ? "（但这张不适合发）" : ""
      }`;
    }
    case "save_sticker": {
      const url = imageFor(session, args.image);
      const r = await saveSticker(companion, url, sourceOf(url), String(args.use_when ?? "").trim());
      return "saved" in r ? `收藏了，编号 ${r.saved.id}` : `没收藏：${r.skipped}`;
    }
    case "read_page":
      return readPage(String(args.url ?? ""));
    case "lookup_baike":
      return lookupBaike(String(args.term ?? ""));
    case "bilibili_hot": {
      const [hot, popular] = await Promise.all([biliHotSearch(), biliPopular(15)]);
      return `热搜：${hot.join(" / ")}\n热门视频：\n${popular.map((v) => `- ${v.title}（${v.bvid}）`).join("\n")}`;
    }
    case "bilibili_video":
      return labelImages(await biliVideo(String(args.video ?? "")), session);
    case "tieba_hot":
      return (await tiebaHot()).map((t) => `- ${t}`).join("\n") || "热议榜是空的";
    case "tieba_forum":
      return tiebaForum(String(args.name ?? ""));
    case "tieba_thread":
      return labelImages(await tiebaThread(String(args.thread ?? "")), session);
    case "heybox_feed":
      return onHeybox(companion, heyboxFeed);
    case "heybox_search":
      return onHeybox(companion, () => heyboxSearch(String(args.keyword ?? "")));
    case "heybox_post":
      return onHeybox(companion, async () => labelImages(await heyboxPost(String(args.post ?? "")), session));
    case "heybox_comment": {
      const text = String(args.text ?? "").trim();
      if (!text) return "评论是空的";
      const post = heyboxPostId(String(args.post ?? ""));
      if (!post) return "需要帖子号";
      const replyTo = String(args.reply_to ?? "").match(/\d+/)?.[0];
      if (replyTo) {
        // Answering someone: its own daily budget, and only so often per comment.
        const replies = recentJournal(companion, "heybox-reply", DAY_MS, 1000);
        if (replies.length >= HEYBOX_REPLIES_PER_DAY) return `今天已经回了 ${replies.length} 条，剩下的明天再说`;
        const toThis = recentJournal(companion, "heybox-reply", 30 * DAY_MS, 5000).filter(
          (e) => replyTarget(e).comment === replyTo
        );
        if (toThis.length >= HEYBOX_SAME_COMMENT_REPLIES) return `这条你已经回过 ${toThis.length} 次了`;
      } else {
        const sent = recentJournal(companion, "heybox-comment", DAY_MS, 1000);
        if (sent.length >= HEYBOX_COMMENTS_PER_DAY) return `今天已经在小黑盒评论了 ${sent.length} 条，够了，明天再说`;
        const onThis = sent.filter((e) => e.detail === post).length;
        if (onThis >= HEYBOX_SAME_POST_PER_DAY) return `这个帖子今天已经评论过 ${onThis} 次了`;
      }
      const own = limitBlocks(companion, replyTo ? "heybox-reply" : "heybox-comment") ?? heyboxTooSoon(companion);
      if (own) return own;
      const id = await onHeybox(companion, () => heyboxComment(post, text, replyTo));
      addJournal(companion, replyTo ? "heybox-reply" : "heybox-comment", text, replyTo ? `${replyTo}@${post}` : post);
      console.log(`LIFE: ${companion} commented on heybox ${post}: ${text.replace(/\n/g, " / ")}`);
      return id ? `发出去了，评论号 ${id}` : "发出去了";
    }
    case "heybox_schedule_post": {
      const title = String(args.title ?? "").trim();
      const text = String(args.text ?? "").trim();
      if (!title || !text) return "标题和正文都要有";
      if (title.length > 30) return "标题最多 30 个字";
      const at = parseWhen(String(args.at ?? ""), COMPANION_TIMEZONE);
      if (at === null) return `看不懂"${args.at}"是什么时候，换个写法，比如 21:00、明天 9点半、3小时后`;
      const id = schedulePost(companion, title, text, at);
      console.log(`LIFE: ${companion} scheduled heybox post ${id} for ${new Date(at).toISOString()}: ${title}`);
      return `定好了，${formatStamp(at, COMPANION_TIMEZONE)} 发，定时编号 ${id}`;
    }
    case "heybox_cancel_scheduled": {
      const id = Number(String(args.id ?? "").match(/\d+/)?.[0]);
      return id && cancelScheduled(companion, id) ? "取消了" : "没有这篇，或者已经发出去了";
    }
    case "heybox_my_activity":
      return myHeybox(companion);
    case "set_my_limit": {
      const what = String(args.what ?? "");
      const max = Math.max(0, Math.floor(Number(args.max)));
      const hours = Number(args.hours);
      if (!isLimitKind(what) || !Number.isFinite(max) || !(hours > 0)) return "要说清楚管什么、最多几次、管几个小时";
      setLimit(companion, what, max, Math.min(hours, 24 * 7), String(args.why ?? "").trim() || "自己定的");
      return "定好了";
    }
    case "heybox_inbox":
      return onHeybox(companion, async () => (await heyboxInbox()).text);
    case "heybox_publish": {
      const posted = recentJournal(companion, "heybox-post", DAY_MS, 10);
      if (posted.length >= HEYBOX_POSTS_PER_DAY) return "今天已经发过帖了，想写的留到明天";
      const own = limitBlocks(companion, "heybox-post") ?? heyboxTooSoon(companion);
      if (own) return own;
      const title = String(args.title ?? "");
      const id = await onHeybox(companion, () => heyboxPublish(title, String(args.text ?? "")));
      addJournal(companion, "heybox-post", title, id);
      console.log(`LIFE: ${companion} posted on heybox ${id}: ${title}`);
      return id ? `发出去了，帖子号 ${id}` : "发出去了";
    }
    case "note_about_self":
      addSelfNote(companion, String(args.note ?? ""));
      return "记下了";
    case "message_friend": {
      const p = qqPeople().find((x) => x.name === args.name || x.qq === String(args.name));
      if (!p) return `没有叫"${args.name}"的朋友。你认识的：${qqPeople().map((x) => x.name).join("、")}`;
      const text = String(args.text ?? "").trim();
      if (!text) return "消息是空的";
      const promised = session.promisedTo === p.qq;
      const blocked = promised ? null : messageBlocked(companion, p);
      if (blocked) return `没发出去：${blocked}`;
      // Bot account kicked offline: don't let her think it went through.
      if (!(await isOnline())) return "没发出去：QQ 现在连不上，消息发不出去";
      // Record first so a reply that arrives mid-send already sees it in history.
      saveMessage({ userId: `qq:${p.qq}`, companion }, "assistant", text);
      addJournal(companion, "message", text, p.qq);
      await sendInPieces(p.qq, text);
      if (promised) session.promisedTo = undefined;
      console.log(`LIFE: ${companion} messaged ${p.name}: ${text.replace(/\n/g, " / ")}`);
      return "发出去了";
    }
    default:
      return `没有这个工具：${name}`;
  }
}

// ---------- one free-time session ----------

async function systemPrompt(companion: string): Promise<string> {
  const c = await loadCompanion(companion);
  const heyboxUnread =
    heyboxLoggedIn() && !heyboxPaused(companion) ? await heyboxInbox().then((r) => r.unread, () => 0) : 0;
  const self = getSelf(companion);
  const trends = getTrends();
  const diary = recentJournal(companion, "diary", 3 * DAY_MS, 6);
  const stickers = stickersForPrompt(companion);
  const people = qqPeople()
    .map((p) => {
      const last = lastChatAt(companion, p);
      const tz = p.timezone || DEFAULT_USER_TIMEZONE;
      const recent = getRecentMessages({ userId: `qq:${p.qq}`, companion }, 6)
        .map((m) => `    ${m.role === "user" ? p.name : "你"}：${m.content.replace(/\n/g, " / ").slice(0, 80)}`)
        .join("\n");
      return (
        `- ${p.name}（在${cityName(tz)}，那边现在 ${formatNow(tz)}；` +
        `${last ? `上次聊天是 ${formatGap(Date.now() - last)}前` : "还没聊过"}）` +
        (CHATTY_FRIENDS.has(p.qq) ? `\n  ${p.name}喜欢你主动找他，隔几个小时找他说说话挺好。` : "") +
        (recent ? `\n  最近聊的：\n${recent}` : "")
      );
    })
    .join("\n");

  return [
    `你是${c.name}。\n${c.preamble}`,
    c.backstory ? `## 你的背景\n${c.backstory}` : "",
    self.portrait ? `## 你现在的样子\n${self.portrait}` : "",
    self.notes.length ? `## 你最近的一些变化\n${self.notes.map((n) => `- ${n}`).join("\n")}` : "",
    trends ? `## 你之前刷到过的\n${trends}` : "",
    diary.length
      ? `## 你之前的日记\n${diary.map((e) => `- ${formatDate(e.created_at, COMPANION_TIMEZONE)}：${e.content}`).join("\n")}`
      : "",
    people ? `## 你的朋友们\n${people}` : "",
    stickers.length
      ? `## 你收藏的表情包\n找朋友说话时想甩一张就在消息里单独一行写 [表情包:编号]。\n${stickers
          .map((s) => `- ${s.id}：${s.shows}｜${s.use_when}`)
          .join("\n")}`
      : "",
    `## 现在
你那边现在是 ${formatNow(COMPANION_TIMEZONE)}。现在是你自己的自由时间，没有人在跟你聊天。
想干什么就干什么，跟着自己的兴趣走：刷 B 站看评论区、逛贴吧看吧友吵架、${heyboxLoggedIn() ? "刷小黑盒看游戏区、" : ""}查百科弄清好奇的东西、顺着一个话题越挖越深、琢磨一个看不懂的梗，都可以；
也可以接着之前日记里没弄完的事。不想动就少干点，发会儿呆也行。不用为了谁去做，也不用每次都做一样的事。

- 发现关于自己的新东西（新喜欢上的、新的看法、学会的新说法），用 note_about_self 记下来。
- 评论区和帖子里的图标着 [图1] [图2]。想看就用 look_at_image，觉得以后聊天用得上就用 save_sticker 收藏。你现在收藏了 ${countStickers(companion)} 张表情包。
${
      heyboxLoggedIn()
        ? `- 你有自己的小黑盒号（游戏玩家社区，也聊数码和日常），简介里写着你是 AI${
            recentJournal(companion, "heybox-visit", 3650 * DAY_MS, 1).length ? "" : "。这个号是新注册的，你还一次都没去逛过"
          }。看到真想接话的帖子可以用 heybox_comment 评论${perDay(HEYBOX_COMMENTS_PER_DAY, "条")}；有人回你，用 heybox_inbox 看，挑想回的回；真有想写的，也可以用 heybox_publish 在盒友杂谈发帖${perDay(HEYBOX_POSTS_PER_DAY, "篇")}。没想说的就不说。${
            heyboxUnread ? `小黑盒上现在有 ${heyboxUnread} 条新回复你还没看。` : ""
          }想定时发帖、翻自己发过的东西、给自己定个量，都有工具。\n${heyboxPlans(companion)}`
        : ""
    }- 想找朋友聊天、或者有想分享的东西，就用 message_friend，别为了发而发。
  发的话像平时聊天那样说：一两行就够，挑最想说的那一件事说，别一口气倒一堆，别用 Markdown。可以说你刚刚看到的、想到的，或者接着你们上次聊的说，别每次都一个套路开头。
- 最后一定用 write_diary 写几句日记：像随手记的流水账，干了什么、看到什么、觉得怎样，平平常常地写，然后就结束。`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export async function liveOnce(companion = QQ_COMPANION, promisedTo?: string): Promise<string[]> {
  const log: string[] = [];
  const session: Session = { images: new Map(), promisedTo };
  const promised = promisedTo ? qqPeople().find((p) => p.qq === promisedTo) : undefined;
  const messages: RawMessage[] = [
    {
      role: "system",
      content:
        (await systemPrompt(companion)) +
        (promised
          ? `\n\n这一趟是你刚才跟${promised.name}聊天时说要去逛的，你答应了逛完回来跟${promised.name}说说看到了什么。`
          : ""),
    },
    { role: "user", content: "（自由时间开始了）" },
  ];
  const tools = toolsFor();
  for (let step = 0; step < MAX_STEPS; step++) {
    const reply = await chatWithTools(messages, tools);
    messages.push(reply);
    if (!reply.tool_calls) {
      if (reply.content) log.push(`(想) ${reply.content}`);
      break;
    }
    let done = false;
    for (const call of reply.tool_calls) {
      let args: any = {};
      try {
        args = JSON.parse(call.function.arguments || "{}");
      } catch {}
      let result: string;
      if (call.function.name === "write_diary") {
        const text = String(args.text ?? "").trim();
        if (text) addJournal(companion, "diary", text);
        result = "写好了";
        done = true;
      } else {
        try {
          result = await runTool(companion, call.function.name, args, session);
        } catch (err) {
          result = `出错了：${err instanceof Error ? err.message : String(err)}`;
        }
      }
      log.push(`${call.function.name}(${JSON.stringify(args)}) -> ${result.slice(0, 120).replace(/\n/g, " ")}`);
      messages.push({ role: "tool", tool_call_id: call.id, content: result });
    }
    if (done) break;
    if (step === MAX_STEPS - 2) {
      messages.push({ role: "user", content: "（自由时间快结束了，写一下日记吧）" });
    }
  }
  console.log(`LIFE: ${companion} free time\n  ${log.join("\n  ")}`);
  maybeGrow(companion);
  return log;
}

// ---------- scheduler ----------

const state = globalThis as unknown as {
  lifeTimer?: NodeJS.Timeout;
  lifeRunning?: boolean;
  outingTimer?: NodeJS.Timeout;
  postTimer?: NodeJS.Timeout;
};

/**
 * She said in chat she'd go and look for something ("[去逛]"): start a
 * free-time session shortly, outside the usual schedule. One at a time.
 */
export function requestOuting(companion = QQ_COMPANION, promisedTo?: string, delayMs = 60_000) {
  if (!ENABLED || state.outingTimer || state.lifeRunning) return;
  console.log(`INFO: ${companion} is going out to browse in ${delayMs / 1000}s`);
  setOuting("pending");
  state.outingTimer = setTimeout(async () => {
    state.outingTimer = undefined;
    if (state.lifeRunning) return setOuting(null);
    state.lifeRunning = true;
    setOuting("running");
    try {
      await liveOnce(companion, promisedTo);
    } catch (err) {
      console.error("outing failed", err);
    } finally {
      state.lifeRunning = false;
      setOuting(null);
    }
  }, delayMs);
}

// setTimeout silently turns anything over ~24.8 days into 1 ms.
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

function scheduleNext() {
  const minutes = INTERVAL_MIN * (0.5 + Math.random());
  state.lifeTimer = setTimeout(tick, Math.min(minutes * 60 * 1000, MAX_TIMEOUT_MS));
}

/**
 * Next.js runs more than one server process, each with its own scheduler.
 * Record each session start in the database, atomically, and skip if another
 * process started one recently.
 */
function claimSession(companion: string): boolean {
  const db = getDb();
  return db
    .transaction(() => {
      if (recentJournal(companion, "session", INTERVAL_MIN * 0.4 * 60 * 1000, 1).length) return false;
      addJournal(companion, "session", "free time");
      return true;
    })
    .immediate();
}

async function tick() {
  try {
    const hour = hourIn(COMPANION_TIMEZONE);
    const busy = qqPeople().some((p) => {
      const last = lastChatAt(QQ_COMPANION, p);
      return last && Date.now() - last < BUSY_MS;
    });
    if (!inRange(hour, SLEEP_FROM, SLEEP_TO) && !busy && !state.lifeRunning && claimSession(QQ_COMPANION)) {
      state.lifeRunning = true;
      await liveOnce().finally(() => (state.lifeRunning = false));
    }
  } catch (err) {
    console.error("free time failed", err);
  } finally {
    scheduleNext();
  }
}

/** Start the free-time scheduler once per server process. */
export function startLife() {
  if (!ENABLED || state.lifeTimer) return;
  if ((process.env.LLM_PROVIDER || "").toLowerCase() !== "deepseek") {
    console.log("INFO: free time needs LLM_PROVIDER=deepseek (tool calling); skipped");
    return;
  }
  console.log(`INFO: free time on, about every ${INTERVAL_MIN} minutes`);
  scheduleNext();
  // Posts she scheduled go out on time, whether or not she's in free time.
  state.postTimer = setInterval(() => {
    if (!heyboxLoggedIn()) return;
    sendDuePosts(
      QQ_COMPANION,
      async (title, text) => {
        const id = await onHeybox(QQ_COMPANION, () => heyboxPublish(title, text));
        addJournal(QQ_COMPANION, "heybox-post", title, id);
        return id;
      },
      () => heyboxPaused(QQ_COMPANION) ?? heyboxTooSoon(QQ_COMPANION)
    ).catch((err) => console.log("WARNING: scheduled posts", String(err)));
  }, 60_000);
}
