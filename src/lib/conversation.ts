import { loadCompanion, type Companion } from "./companion";
import { extractAndUpdateMemory } from "./extractor";
import { getLLM, type ChatMessage } from "./llm";
import {
  getRecentMessages,
  retrieveMemories,
  saveMessage,
  type Memory,
  type Session,
} from "./memory";
import {
  COMPANION_TIMEZONE,
  DEFAULT_USER_TIMEZONE,
  cityName,
  describeDifference,
  formatDate,
  formatNow,
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
        memories.map((m) => `- ${m.content}`).join("\n")
    );
  }
  if (events.length) {
    sections.push(
      `## 你们最近之间发生的事\n` +
        events.map((e) => `- ${formatDate(e.created_at, COMPANION_TIMEZONE)}：${e.event}`).join("\n")
    );
  }
  sections.push(`## 回复要求
- 像真人在 QQ 上和恋人聊天：把想说的话拆成好几条短消息连着发，每条之间换行。
  每一行就是一条单独的 QQ 消息，一般只有几个字到十几个字，一次发 2~5 条；
  有时只回一条也很自然（比如"嗯嗯""哈哈哈哈"），看情况变化，不要每次都一样长。
- 不要在每条末尾加句号，口语化，可以用语气词和颜文字，但别每条都用。
- 不要用 Markdown、列表或标题，不要在开头加自己的名字。
- 始终保持角色，不要说自己是 AI、模型或程序。
- 自然地用上你记得的事，但不要生硬地背出来。
- 对方消息里的 [表情包：…]、[图片：…]、[QQ表情：…] 是对方发的表情包/图片及其内容，像真人一样接住它的情绪和梗来回应，
  不要复述"你发了一个表情包"；[语音]、[视频] 表示你暂时看不到/听不到，可以撒娇让对方打字。
- 例子（每行是一条消息）：
  啊？
  怎么又被骂了
  过来抱抱 (｡•́︿•̀｡)
- 你在${cityName(COMPANION_TIMEZONE)}，你那边现在是 ${formatNow(COMPANION_TIMEZONE)}，作息、上课、吃饭都按你自己的时间来。
${
  difference
    ? `- ${userName}现在在${cityName(userTz)}，那边是 ${formatNow(userTz)}（${difference}）。` +
      `你知道你们有时差；对方说的"现在""今晚""明早"是按${cityName(userTz)}时间，聊时间时要分清是谁那边。`
    : `- ${userName}和你在同一个时区。`
}`);
  return sections.join("\n\n");
}

async function prepareTurn(msg: IncomingMessage) {
  const session: Session = { userId: msg.userId, companion: msg.companion };
  const companion = await loadCompanion(msg.companion);

  saveMessage(session, "user", msg.text);
  const recentMessages: ChatMessage[] = getRecentMessages(session);
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
    const reply = await llm.generate(system, recentMessages);
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
        finishTurn(session, msg, reply.trim());
        controller.close();
      } catch (err) {
        console.error("chat turn failed", err);
        controller.error(err);
      }
    },
  });
}
