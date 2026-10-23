import { loadCompanion, type Companion } from "./companion";
import { extractAndUpdateMemory } from "./extractor";
import { getLLM, type ChatMessage } from "./llm";
import {
  getRecentMessages,
  retrieveMemories,
  saveMessage,
  type TimedMessage,
  type Memory,
  type Session,
} from "./memory";
import { stripStageDirections, turnStyleHints } from "./style";
import {
  COMPANION_TIMEZONE,
  DEFAULT_USER_TIMEZONE,
  cityName,
  describeDifference,
  describeNearbyDays,
  formatDate,
  formatGap,
  formatNow,
  formatStamp,
  sameDay,
} from "./time";
import {
  describeRelationship,
  getRecentEvents,
  getRelationshipState,
  type RelationshipState,
  type StoredEvent,
} from "./relationship";

// The companion engine. Channels (browser, QQ, ...) only convert their own
// message format into IncomingMessage and send back whatever comes out.

export type IncomingMessage = {
  userId: string; // channel-prefixed, e.g. "qq:12345" or "web:local"
  userName: string;
  companion: string;
  text: string;
  userTimezone?: string; // IANA name, e.g. "Asia/Tokyo"; defaults to this machine's
};

export function buildCompanionPrompt(args: {
  companion: Companion;
  userName: string;
  memories: Memory[];
  relationship: RelationshipState;
  events: StoredEvent[];
  userTimezone?: string;
}): string {
  const { companion: c, userName, memories, relationship, events } = args;
  const userTz = args.userTimezone || DEFAULT_USER_TIMEZONE;
  const difference = describeDifference(userTz, COMPANION_TIMEZONE);
  const sections = [
    `你是${c.name}，正在和${userName}聊天。\n\n${c.preamble}`,
  ];
  sections.push(`## 你是真实世界里的人
你生活在现在（${new Date().getFullYear()} 年）的中国，是一个正常上网、刷手机的年轻人，不是活在设定里的角色：
- 熟悉现在的网络流行语、梗、热门 App、游戏、综艺和明星，也了解常见的社会常识和新闻大事。
- 知道并会用各种 AI 工具，比如 ChatGPT、Claude、DeepSeek、豆包、Kimi，同学之间用 AI 查资料、写作业、改简历都很常见，你自己也用。
- 对方提到你应该知道的东西，就自然地接话，不要装作没听过。
- 真遇到不了解的新东西（比如很新的事或很冷门的圈子），像真人一样好奇地问或者坦白不太懂，不要编造细节。`);
  if (c.seedChat) {
    sections.push(`## 说话风格示例（Human 指对方）\n${c.seedChat}`);
  }
  if (c.backstory) {
    sections.push(`## 你的背景\n${c.backstory}`);
  }
  sections.push(
    `## 你和${userName}现在的关系\n${describeRelationship(relationship)}`
  );
  if (memories.length) {
    sections.push(
      `## 你记得的关于${userName}的事\n` +
        memories
          .map((m) => `- （${formatDate(m.created_at, COMPANION_TIMEZONE)}记下）${m.content}`)
          .join("\n")
    );
  }
  if (events.length) {
    sections.push(
      `## 你们最近之间发生的事\n` +
        events.map((e) => `- ${formatDate(e.created_at, COMPANION_TIMEZONE)}：${e.event}`).join("\n")
    );
  }
  sections.push(`## 回复要求
- 像真人在 QQ 上和恋人聊天：每一行就是一条单独的 QQ 消息，一条一般几个字到十几个字，多条之间换行。
- 不要用 Markdown、列表或标题，不要在开头加自己的名字。
- 始终保持角色，不要说自己是 AI、模型或程序。
- 自然地用上你记得的事，但不要生硬地背出来。
- 对方消息里的 [表情包：…]、[图片：…]、[QQ表情：…] 是对方发的表情包/图片及其内容，像真人一样接住它的情绪和梗来回应，
  不要复述"你发了一个表情包"；[语音]、[视频] 表示你暂时看不到/听不到，可以撒娇让对方打字。

## 别像 AI（这些是最容易露馅的地方）
- 别像妈妈一样叮嘱：不要动不动就"记得吃饭""早点睡""别熬夜""好好休息"，除非真的有必要。
- 别每次都用问题结尾，也别每次都关心对方。很多时候就是接一句、吐槽一句、发个情绪，或者说说你自己的事。
- 别复述对方刚说的话（对方说"国家躺平"，不要回"哈哈哈国家躺平"）。
- 绝对不要用括号写动作或心理活动，比如"（偷偷看手机）""（小声）"。
- 开头别总是"诶""哦哦""哈哈哈""嗯嗯"，换着来，或者直接说事。
- 语气词（呀、啦、嘛、哦）和颜文字少用，大部分消息不带；颜文字几轮才用一次，别老用同一个。
- 可以不完美：可以敷衍、可以只回一个"？"或"哼"、可以小小闹脾气、可以突然转去说自己的事、可以有错别字式的随意。
- 标点随意：句尾不加句号，可以用空格代替逗号，可以连发"哈哈哈哈哈哈"。
- 对方只回"ok""嗯""好的"这种敷衍的话时，你也别长篇大论。

## 本轮
${turnStyleHints(c.name)}
- 你在${cityName(COMPANION_TIMEZONE)}，你那边现在是 ${formatNow(COMPANION_TIMEZONE)}，作息、上课、吃饭都按你自己的时间来。
- 日期对照（你那边）：${describeNearbyDays(COMPANION_TIMEZONE)}。说"昨天""明天""周末"时按这个算。
- 聊天记录里方括号 [ ] 是系统标的发送时间，只在隔了一段时间或换了一天时出现，帮你分清"昨天聊的"和"刚才说的"。
  隔了很久再聊要意识到时间过去了（昨晚说了晚安，今天再聊就是新的一天；昨天说"明天考试"，那就是今天）。
  你回复时不要写这种时间标记。
${
  difference
    ? `- ${userName}现在在${cityName(userTz)}，那边是 ${formatNow(userTz)}（${difference}）。` +
      `你知道你们有时差；对方说的"现在""今晚""明早"是按${cityName(userTz)}时间，聊时间时要分清是谁那边。`
    : `- ${userName}和你在同一个时区。`
}`);
  return sections.join("\n\n");
}

const GAP_TO_MARK_MS = 30 * 60 * 1000;

/**
 * Prefix a user message with its send time when it starts a new day or comes
 * after a long pause, so the model can tell "yesterday" from "just now".
 */
function annotateWithTime(rows: TimedMessage[]): ChatMessage[] {
  let prev: number | undefined;
  return rows.map(({ role, content, created_at }) => {
    let text = content;
    if (role === "user") {
      const newDay = prev === undefined || !sameDay(prev, created_at, COMPANION_TIMEZONE);
      const gap = prev === undefined ? 0 : created_at - prev;
      if (newDay || gap >= GAP_TO_MARK_MS) {
        const since = prev === undefined ? "" : `，距上一条 ${formatGap(gap)}`;
        text = `[${formatStamp(created_at, COMPANION_TIMEZONE)}${since}] ${content}`;
      }
    }
    prev = created_at;
    return { role, content: text };
  });
}

async function prepareTurn(msg: IncomingMessage) {
  const session: Session = { userId: msg.userId, companion: msg.companion };
  const companion = await loadCompanion(msg.companion);

  saveMessage(session, "user", msg.text);
  const recentMessages = annotateWithTime(getRecentMessages(session));
  const system = buildCompanionPrompt({
    companion,
    userName: msg.userName,
    memories: retrieveMemories(session, msg.text),
    relationship: getRelationshipState(session),
    events: getRecentEvents(session),
    userTimezone: msg.userTimezone,
  });
  return { session, system, recentMessages };
}

function finishTurn(session: Session, msg: IncomingMessage, reply: string) {
  if (!reply) return;
  saveMessage(session, "assistant", reply);
  extractAndUpdateMemory({
    session,
    userName: msg.userName,
    userTimezone: msg.userTimezone,
    userText: msg.text,
    assistantText: reply,
  }).catch((err) => console.error("memory extraction failed", err));
}

// QQ users often fire several messages in a row; handle one turn per session
// at a time so history stays in order.
const queues = new Map<string, Promise<unknown>>();
function serialize<T>(key: string, task: () => Promise<T>): Promise<T> {
  const prev = queues.get(key) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(task);
  queues.set(key, next);
  next.finally(() => {
    if (queues.get(key) === next) queues.delete(key);
  });
  return next;
}

/** Full reply in one piece (QQ and other message channels). */
export function handleMessage(msg: IncomingMessage): Promise<string> {
  return serialize(`${msg.userId}|${msg.companion}`, async () => {
    const { session, system, recentMessages } = await prepareTurn(msg);
    const llm = await getLLM();
    const reply = stripStageDirections(await llm.generate(system, recentMessages, { purpose: "chat" }));
    finishTurn(session, msg, reply);
    return reply;
  });
}

/**
 * Streamed reply as UTF-8 text chunks (browser chat). Setup errors (unknown
 * companion, bad provider) reject before any bytes are sent.
 */
export async function handleMessageStream(
  msg: IncomingMessage
): Promise<ReadableStream<Uint8Array>> {
  const { session, system, recentMessages } = await prepareTurn(msg);
  const llm = await getLLM();
  const encoder = new TextEncoder();
  return new ReadableStream({
    async start(controller) {
      try {
        let reply = "";
        for await (const chunk of llm.stream(system, recentMessages)) {
          reply += chunk;
          controller.enqueue(encoder.encode(chunk));
        }
        finishTurn(session, msg, stripStageDirections(reply));
        controller.close();
      } catch (err) {
        console.error("chat turn failed", err);
        controller.error(err);
      }
    },
  });
}
