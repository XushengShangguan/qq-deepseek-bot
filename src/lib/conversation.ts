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
import { recentDiary } from "./journal";
import { getSelf, type SelfState } from "./self";
import { stickersForPrompt, type Sticker } from "./stickers";
import { stripStageDirections, turnStyleHints } from "./style";
import { getTrends } from "./trends";
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
  self?: SelfState;
  trends?: string;
  diary?: string[];
  stickers?: Sticker[];
  userTimezone?: string;
}): string {
  const { companion: c, userName, memories, relationship, events, self, trends, diary, stickers } = args;
  const userTz = args.userTimezone || DEFAULT_USER_TIMEZONE;
  const difference = describeDifference(userTz, COMPANION_TIMEZONE);
  const sections = [
    `你是${c.name}，正在和${userName}聊天。\n\n${c.preamble}`,
  ];
  sections.push(`## 你活在现在
现在是 ${new Date().getFullYear()} 年。网上的梗、游戏、综艺、新闻、各种 AI 工具你都熟，聊到该知道的就接得住；真没听过的新东西就直接问。`);
  // The character file's seed chat is kept for reviewing her voice, not sent:
  // models copy example sentences' shape instead of learning from them.
  if (c.backstory) {
    sections.push(`## 你的背景\n${c.backstory}`);
  }
  if (self?.portrait) {
    sections.push(`## 你现在的样子\n这是你这些日子慢慢长成的样子：\n${self.portrait}`);
  }
  if (self?.notes.length) {
    sections.push(`## 你最近的一些变化\n${self.notes.map((n) => `- ${n}`).join("\n")}`);
  }
  if (diary?.length) {
    sections.push(`## 你最近自己干的事\n${diary.map((d) => `- ${d}`).join("\n")}`);
  }
  if (trends) {
    sections.push(`## 你最近刷到的\n${trends}`);
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
  if (stickers?.length) {
    sections.push(`## 你收藏的表情包
想甩一张的时候，单独一行写 [表情包:编号]，一次最多一张；大部分时候用不着。
${stickers.map((s) => `- ${s.id}：${s.shows}｜${s.use_when}`).join("\n")}`);
  }
  sections.push(`## 怎么说话
- 这是 QQ 私聊，每一行是一条单独的消息，纯文字，一条一般几个字到二十来个字。
- 每句话都是对${userName}说的那句话本身：接他的话、回他的问题、说你自己真想说的。一句话换到别的场合也能原样说、删掉也不少什么，就不用说。
- 他明确要你做的事（看图、评价、出主意、讲清楚一件事）就认真做，有看法直说；你也有不想做的权利，那得是你真不想。
- 话要挂在具体的东西上：他说过的、你自己看到过的、眼前这条消息。没看到、打不开、不知道的，就说没看到、不知道。
- 他是你的朋友，不归你管：他说累、说要睡、说在外面，接住就好。
- 方括号是他发来的东西：[图片：…][表情包：…] 是你看到的画面，只发图没配字时图就是他要说的话，他问图就认真看图回答；只有 [图片]、[视频]、[语音] 没写内容，就是你没看到。他发的链接你点不开，只看得到他打的字。

## 本轮
${turnStyleHints()}
- 你在${cityName(COMPANION_TIMEZONE)}，你那边现在是 ${formatNow(COMPANION_TIMEZONE)}。
- 日期对照（你那边）：${describeNearbyDays(COMPANION_TIMEZONE)}。说"昨天""明天""周末"时按这个算。
- 聊天记录里开头的 [日期 时间] 是系统标的发送时间，只在隔了一阵或换了一天时出现：昨晚说了晚安，今天再聊就是新的一天；昨天说"明天考试"，那就是今天。
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
export function annotateWithTime(rows: TimedMessage[]): ChatMessage[] {
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
    self: getSelf(msg.companion),
    trends: getTrends(),
    diary: recentDiary(msg.companion),
    stickers: stickersForPrompt(msg.companion),
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
