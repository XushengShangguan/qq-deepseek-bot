import { getLLM } from "./llm";
import { addMemory, listMemories, type NewMemory, type Session } from "./memory";
import {
  recordRelationshipEvent,
  type RelationshipEvent,
} from "./relationship";

// After each meaningful turn, ask the model what (if anything) is worth
// remembering (plan §6.5). Runs in the background; never blocks the reply.

const ENABLED = (process.env.MEMORY_EXTRACTION || "on") !== "off";

const SYSTEM = `你是一个"记忆整理员"，负责为一个陪伴型聊天角色整理长期记忆。
你会看到用户和角色刚刚的一轮对话，以及角色已经记住的内容。
判断这一轮里有没有值得长期记住的信息，只输出 JSON，不要输出任何其他文字。

值得记住的：用户的个人信息、喜好/讨厌、重要的人、学业工作、近期计划和日程、重要经历、情绪困扰、你们之间的约定和共同经历。
不值得记住的：寒暄、客套、临时闲聊、已经记住过的内容、角色自己说的设定。

memory 的写法：用第三人称陈述事实，例如"用户对芒果过敏"；涉及时间的要换算成具体日期。
category 取值：profile | preference | interest | life_event | plan | people | shared_history | other
importance：0~1，日常小喜好约 0.3，重要的人/事/计划约 0.7，非常重大的事约 0.9。

relationship_event：只有当这一轮对你们的关系有实际影响时才填写（例如用户倾诉心事、表达感谢、吵架、和好、做出约定），否则为 null。
effect 是对亲密度 closeness / 信任 trust / 俏皮 playfulness 的变化，每项 -5 到 5 的整数，大多数时候是 0~2 的小变化。

输出格式：
{"memories": [{"content": "...", "category": "...", "tags": ["关键词"], "importance": 0.5}],
 "relationship_event": null 或 {"event": "...", "emotion": "...", "importance": 0.5, "effect": {"closeness": 0, "trust": 0, "playfulness": 0}}}
没有需要记的就输出 {"memories": [], "relationship_event": null}`;

type Extraction = {
  memories?: NewMemory[];
  relationship_event?: RelationshipEvent | null;
};

function parseJson(text: string): Extraction | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

// Skip "嗯" / "哈哈" / "ok" style turns; nothing to remember there.
function isTrivial(text: string) {
  return text.replace(/[\s\p{P}\p{S}]+/gu, "").length < 4;
}

export async function extractAndUpdateMemory(args: {
  session: Session;
  userName: string;
  userText: string;
  assistantText: string;
}) {
  if (!ENABLED || isTrivial(args.userText)) return;

  const known = listMemories(args.session)
    .slice(0, 30)
    .map((m) => `- ${m.content}`)
    .join("\n");

  const prompt = `今天是 ${new Date().toLocaleDateString("zh-CN")}。
用户的称呼：${args.userName}

已经记住的内容：
${known || "（暂无）"}

刚刚的对话：
用户：${args.userText}
角色：${args.assistantText}`;

  const llm = await getLLM();
  const raw = await llm.generate(SYSTEM, [{ role: "user", content: prompt }], {
    purpose: "extract",
    maxTokens: 2000,
  });
  const result = parseJson(raw);
  if (!result) {
    console.log("WARNING: memory extractor returned non-JSON:", raw);
    return;
  }

  for (const m of result.memories ?? []) {
    if (m?.content) addMemory(args.session, m);
  }
  if (result.relationship_event?.event) {
    recordRelationshipEvent(args.session, result.relationship_event);
  }
  if (result.memories?.length || result.relationship_event) {
    console.log("INFO: memory updated", JSON.stringify(result));
  }
}
