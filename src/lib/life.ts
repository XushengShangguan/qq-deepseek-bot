import { loadCompanion } from "./companion";
import { chatWithTools, type RawMessage, type ToolSpec } from "./deepseek";
import { getDb } from "./db";
import { addJournal, recentJournal } from "./journal";
import { getRecentMessages, saveMessage } from "./memory";
import { isOnline, qqPeople, sendInPieces, QQ_COMPANION, type QQPerson } from "./qq";
import { addSelfNote, getSelf, maybeGrow } from "./self";
import { COMPANION_TIMEZONE, DEFAULT_USER_TIMEZONE, cityName, formatDate, formatGap, formatNow, hourIn } from "./time";
import { getTrends } from "./trends";
import { biliHotSearch, biliPopular, biliVideo, lookupBaike, readPage, tiebaForum, tiebaHot, tiebaThread } from "./web";

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
const MAX_STEPS = Number(process.env.LIFE_MAX_STEPS || 12);
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

async function runTool(companion: string, name: string, args: any): Promise<string> {
  switch (name) {
    case "read_page":
      return readPage(String(args.url ?? ""));
    case "lookup_baike":
      return lookupBaike(String(args.term ?? ""));
    case "bilibili_hot": {
      const [hot, popular] = await Promise.all([biliHotSearch(), biliPopular(15)]);
      return `热搜：${hot.join(" / ")}\n热门视频：\n${popular.map((v) => `- ${v.title}（${v.bvid}）`).join("\n")}`;
    }
    case "bilibili_video":
      return biliVideo(String(args.video ?? ""));
    case "tieba_hot":
      return (await tiebaHot()).map((t) => `- ${t}`).join("\n") || "热议榜是空的";
    case "tieba_forum":
      return tiebaForum(String(args.name ?? ""));
    case "tieba_thread":
      return tiebaThread(String(args.thread ?? ""));
    case "note_about_self":
      addSelfNote(companion, String(args.note ?? ""));
      return "记下了";
    case "message_friend": {
      const p = qqPeople().find((x) => x.name === args.name || x.qq === String(args.name));
      if (!p) return `没有叫"${args.name}"的朋友。你认识的：${qqPeople().map((x) => x.name).join("、")}`;
      const text = String(args.text ?? "").trim();
      if (!text) return "消息是空的";
      const blocked = messageBlocked(companion, p);
      if (blocked) return `没发出去：${blocked}`;
      // Bot account kicked offline: don't let her think it went through.
      if (!(await isOnline())) return "没发出去：QQ 现在连不上，消息发不出去";
      // Record first so a reply that arrives mid-send already sees it in history.
      saveMessage({ userId: `qq:${p.qq}`, companion }, "assistant", text);
      addJournal(companion, "message", text, p.qq);
      await sendInPieces(p.qq, text);
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
  const self = getSelf(companion);
  const trends = getTrends();
  const diary = recentJournal(companion, "diary", 3 * DAY_MS, 6);
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
    `## 现在
你那边现在是 ${formatNow(COMPANION_TIMEZONE)}。现在是你自己的自由时间，没有人在跟你聊天。
想干什么就干什么，跟着自己的兴趣走：刷 B 站看评论区、逛贴吧看吧友吵架、查百科弄清好奇的东西、顺着一个话题越挖越深、琢磨一个看不懂的梗，都可以；
也可以接着之前日记里没弄完的事。不想动就少干点，发会儿呆也行。不用为了谁去做，也不用每次都做一样的事。

- 发现关于自己的新东西（新喜欢上的、新的看法、学会的新说法），用 note_about_self 记下来。
- 想找朋友聊天、或者有想分享的东西，就用 message_friend，别为了发而发。
  发的话像平时聊天那样说：一两行就够，挑最想说的那一件事说，别一口气倒一堆，别用 Markdown。可以说你刚刚看到的、想到的，或者接着你们上次聊的说，别每次都一个套路开头。
- 最后一定用 write_diary 写几句日记，记下这次干了什么、什么感觉，然后就结束。`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export async function liveOnce(companion = QQ_COMPANION): Promise<string[]> {
  const log: string[] = [];
  const messages: RawMessage[] = [
    { role: "system", content: await systemPrompt(companion) },
    { role: "user", content: "（自由时间开始了）" },
  ];
  for (let step = 0; step < MAX_STEPS; step++) {
    const reply = await chatWithTools(messages, TOOLS);
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
          result = await runTool(companion, call.function.name, args);
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

const state = globalThis as unknown as { lifeTimer?: NodeJS.Timeout; lifeRunning?: boolean };

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
}
