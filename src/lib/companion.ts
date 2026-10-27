import fs from "fs/promises";
import path from "path";

// Character files keep the original a16z format:
//   <persona / core personality>
//   ###ENDPREAMBLE###
//   <seed chat showing speaking style>
//   ###ENDSEEDCHAT###
//   <backstory>
// The original app only pulled backstory in via vector search; with no
// embeddings in the MVP, the whole (short) backstory goes into the prompt.

export type Companion = {
  name: string;
  preamble: string;
  seedChat: string;
  backstory: string;
};

const cache = new Map<string, Companion>();

export async function loadCompanion(name: string): Promise<Companion> {
  // Names come from request headers / config; never let them escape companions/.
  if (!/^[\w一-鿿-]+$/.test(name)) {
    throw new Error(`Invalid companion name "${name}"`);
  }
  const cached = cache.get(name);
  if (cached && process.env.NODE_ENV === "production") return cached;

  const data = await fs.readFile(
    path.join("companions", `${name}.txt`),
    "utf8"
  );
  const [preamble, rest = ""] = data.split("###ENDPREAMBLE###");
  const [seedChat, backstory = ""] = rest.split("###ENDSEEDCHAT###");
  // Who her friends are names real people, so it lives in <name>.private.txt,
  // which git ignores; it goes in front of the rest of the backstory.
  const friends = await fs.readFile(path.join("companions", `${name}.private.txt`), "utf8").catch(() => "");
  const companion = {
    name,
    preamble: preamble.trim(),
    seedChat: seedChat.trim(),
    backstory: [friends.trim(), backstory.trim()].filter(Boolean).join("\n"),
  };
  cache.set(name, companion);
  return companion;
}
