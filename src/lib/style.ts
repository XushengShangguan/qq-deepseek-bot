import fs from "fs";
import path from "path";

// Per-turn variety so replies don't settle into one robotic rhythm:
// a random reply "shape", and a random handful of everyday internet phrases
// as vocabulary hints. Both change every turn.

type Shape = { weight: number; text: string };

const SHAPES: Shape[] = [
  { weight: 50, text: "这次只回 1 条，很短，几个字就行（比如一个反应、一句吐槽、一个\"嗯\"）" },
  { weight: 35, text: "这次回 2 条" },
  { weight: 15, text: "这次回 3 条" },
];

function pickShape(): string {
  const total = SHAPES.reduce((s, x) => s + x.weight, 0);
  let r = Math.random() * total;
  for (const s of SHAPES) {
    if ((r -= s.weight) < 0) return s.text;
  }
  return SHAPES[0].text;
}

// Everyday Chinese internet chat vocabulary (Bilibili / Weibo / Xiaohongshu
// register, toned for private chat). Hints only; she picks what fits.
const PHRASES = [
  // reactions
  "笑死", "笑死我了", "哈哈哈哈哈哈哈哈", "绷不住了", "蚌埠住了", "啊这", "？", "？？？",
  "救命", "离谱", "太离谱了", "好家伙", "6", "牛的", "绝了", "我真的会谢", "无语",
  "无语子", "服了", "麻了", "破防了", "典", "有点东西", "真的假的", "不是吧", "啊？",
  "哇塞", "好耶", "芜湖", "我靠", "啊啊啊啊", "呜呜呜", "嘿嘿", "hhh", "草（笑）",
  // agreeing / brushing off
  "嗯嗯", "好滴", "好哒", "行", "好好好", "收到", "ok", "对对对", "确实", "懂了",
  "随便啦", "都行", "看你", "那咋了", "还好吧", "一般般",
  // teasing
  "笨蛋", "哼", "不理你了", "才不要", "你好烦", "略略略", "就要", "你猜", "求求了",
  "就这？", "你行你上", "听我说谢谢你", "大可不必",
  // her own state
  "困死了", "好困", "饿饿", "不想动", "摆烂中", "躺平了", "刚醒", "还没起",
  "摸鱼中", "累死了", "emo了", "好烦啊", "今天好倒霉", "我人傻了",
];

function sample<T>(arr: T[], n: number): T[] {
  const copy = arr.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, n);
}

/**
 * Optional companions/<name>.style.txt: real-sounding chat lines you like,
 * one per line ("#" lines are comments). A few are sampled into every prompt.
 */
function loadStyleExamples(companion: string): string[] {
  try {
    return fs
      .readFileSync(path.join("companions", `${companion}.style.txt`), "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
  } catch {
    return [];
  }
}

export function turnStyleHints(companion: string): string {
  const examples = sample(loadStyleExamples(companion), 8);
  return [
    `- 本轮：${pickShape()}。如果对方在认真倾诉或问了需要解释的事，可以不受这个限制。`,
    `- 本轮可参考的口头禅（只是灵感，合适才用，最多用一两个，别硬塞）：${sample(PHRASES, 14).join(" / ")}`,
    ...(examples.length
      ? [`- 你平时说话的感觉可以参考这些（学语气，不要照抄）：\n${examples.map((e) => `  ${e}`).join("\n")}`]
      : []),
  ].join("\n");
}

/**
 * Remove roleplay stage directions like "（偷偷看着手机）" while keeping
 * kaomoji such as "(｡•̀ᴗ-)✧" (those contain no Chinese characters).
 */
export function stripStageDirections(text: string): string {
  return text
    // Echoed history timestamps like "[10月22日 周三 09:10]".
    .replace(/\[\d{1,2}月\d{1,2}日[^\]]*\]\s*/g, "")
    .split("\n")
    .map((line) =>
      line.replace(/[（(][^（()）]*\p{Script=Han}[^（()）]*[）)]/gu, (m) =>
        // Keep "（笑）"-style one-character asides; drop longer action text.
        m.replace(/[（()）]/g, "").length <= 1 ? m : ""
      ).trim()
    )
    .filter(Boolean)
    .join("\n");
}
