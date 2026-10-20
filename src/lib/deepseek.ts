import type { ChatMessage, GenerateOptions, LLMProvider } from "./llm";

// DeepSeek via its OpenAI-compatible Chat Completions endpoint.
// Docs: https://api-docs.deepseek.com/api/create-chat-completion
const BASE_URL = (process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com").replace(/\/$/, "");
const MODEL = process.env.DEEPSEEK_MODEL || "deepseek-flash";

function requestBody(
  system: string,
  messages: ChatMessage[],
  options: GenerateOptions = {},
  stream: boolean
) {
  return JSON.stringify({
    model: MODEL,
    messages: [{ role: "system", content: system }, ...messages],
    max_tokens: options.maxTokens ?? 2000,
    // Thinking mode is on by default; casual chat and memory extraction don't
    // need it, and turning it off makes replies much faster and cheaper.
    thinking: { type: process.env.DEEPSEEK_THINKING === "on" ? "enabled" : "disabled" },
    ...(options.purpose === "extract"
      ? { response_format: { type: "json_object" } }
      : {}),
    stream,
  });
}

async function post(body: string): Promise<Response> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error("DEEPSEEK_API_KEY is not set in .env.local");
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body,
  });
  if (!res.ok) {
    throw new Error(`DeepSeek API ${res.status}: ${await res.text()}`);
  }
  return res;
}

export const deepseekProvider: LLMProvider = {
  name: `deepseek (${MODEL})`,

  async generate(system, messages, options) {
    const res = await post(requestBody(system, messages, options, false));
    const data = await res.json();
    return (data.choices?.[0]?.message?.content ?? "").trim();
  },

  // deepseek-flash accepts images in user messages (https://api-docs.deepseek.com/guides/vision).
  async describeImage(dataUrl, prompt) {
    const res = await post(
      JSON.stringify({
        model: MODEL,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              // Stickers don't need full resolution; "low" is faster and cheaper.
              { type: "image_url", image_url: { url: dataUrl, detail: "low" } },
            ],
          },
        ],
        max_tokens: 300,
        thinking: { type: "disabled" },
      })
    );
    const data = await res.json();
    return (data.choices?.[0]?.message?.content ?? "").trim();
  },

  // Server-sent events: lines of `data: {json}`, ending with `data: [DONE]`.
  async *stream(system, messages, options) {
    const res = await post(requestBody(system, messages, options, true));
    if (!res.body) throw new Error("DeepSeek returned an empty stream");
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const payload = line.trim();
        if (!payload.startsWith("data:")) continue;
        const data = payload.slice(5).trim();
        if (data === "[DONE]") return;
        const text = JSON.parse(data).choices?.[0]?.delta?.content;
        if (text) yield text;
      }
    }
  },
};
