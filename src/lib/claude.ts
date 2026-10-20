import Anthropic from "@anthropic-ai/sdk";
import type { ChatMessage, GenerateOptions, LLMProvider } from "./llm";

// Model layer only: no QQ, persona or memory logic lives here.
const MODEL = process.env.CLAUDE_MODEL || "claude-opus-5-5";

type Effort = "low" | "medium" | "high" | "xhigh" | "max";
// Casual chat and memory extraction don't need deep thinking; "low" keeps them fast.
const CHAT_EFFORT = (process.env.CHAT_EFFORT || "low") as Effort;
const EXTRACT_EFFORT: Effort = "low";

let client: Anthropic | undefined;
function getClient() {
  // Reads ANTHROPIC_API_KEY (and ANTHROPIC_BASE_URL, if set) from the environment.
  if (!client) client = new Anthropic();
  return client;
}

function startStream(
  system: string,
  messages: ChatMessage[],
  options: GenerateOptions = {}
) {
  return getClient().beta.messages.stream({
    model: MODEL,
    max_tokens: options.maxTokens ?? 4000,
    system,
    messages,
    output_config: {
      effort: options.purpose === "extract" ? EXTRACT_EFFORT : CHAT_EFFORT,
    },
    // On a safety-classifier refusal, the API retries on a fallback model automatically.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
  });
}

function textOf(message: Anthropic.Beta.BetaMessage) {
  if (message.stop_reason === "refusal") {
    console.log("WARNING: Claude refused", message.stop_details);
  }
  return message.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
}

export const claudeProvider: LLMProvider = {
  name: `claude (${MODEL})`,

  async generate(system, messages, options) {
    const final = await startStream(system, messages, options).finalMessage();
    return textOf(final);
  },

  async *stream(system, messages, options) {
    const stream = startStream(system, messages, options);
    for await (const event of stream) {
      if (
        event.type === "content_block_delta" &&
        event.delta.type === "text_delta"
      ) {
        yield event.delta.text;
      }
    }
    textOf(await stream.finalMessage());
  },
};
