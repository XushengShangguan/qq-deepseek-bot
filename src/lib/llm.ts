// Provider-agnostic model layer. Conversation / memory code only talks to this
// interface, so switching Claude <-> DeepSeek (or anything else) means adding one
// provider file and setting LLM_PROVIDER in .env.local.

export type ChatMessage = { role: "user" | "assistant"; content: string };

export type GenerateOptions = {
  // "chat" = in-character reply; "extract" = background JSON extraction work.
  purpose?: "chat" | "extract";
  maxTokens?: number;
};

export interface LLMProvider {
  name: string;
  generate(
    system: string,
    messages: ChatMessage[],
    options?: GenerateOptions
  ): Promise<string>;
  stream(
    system: string,
    messages: ChatMessage[],
    options?: GenerateOptions
  ): AsyncIterable<string>;
}

// No-API provider for testing the UI / SQLite / memory pipeline offline.
// Replies by echoing; the "extractor" remembers every user message verbatim.
const mockProvider: LLMProvider = {
  name: "mock",
  async generate(system, messages, options) {
    const last = messages[messages.length - 1]?.content ?? "";
    if (options?.purpose === "extract") {
      const said = last.match(/用户：([\s\S]*?)\n角色：/)?.[1]?.trim() ?? "";
      return JSON.stringify({
        memories: said
          ? [{ content: `用户说过：${said}`, category: "other", tags: [], importance: 0.5 }]
          : [],
        relationship_event: null,
      });
    }
    return `（mock）收到啦：${last}`;
  },
  async *stream(system, messages, options) {
    yield await this.generate(system, messages, options);
  },
};

let provider: LLMProvider | undefined;

export async function getLLM(): Promise<LLMProvider> {
  if (provider) return provider;
  const name = (process.env.LLM_PROVIDER || "claude").toLowerCase();
  switch (name) {
    case "claude":
      provider = (await import("./claude")).claudeProvider;
      break;
    case "deepseek":
      provider = (await import("./deepseek")).deepseekProvider;
      break;
    case "mock":
      provider = mockProvider;
      break;
    default:
      throw new Error(`Unknown LLM_PROVIDER "${name}"`);
  }
  return provider;
}
