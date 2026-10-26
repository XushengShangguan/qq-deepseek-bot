// Per-turn variety so replies don't settle into one rhythm: a random reply
// length that changes every turn.

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

/**
 * Only the reply length is set per turn. Phrase banks and sample lines used
 * to go here too, at the very end of the prompt; the model copied their
 * wording instead of picking up the register.
 */
export function turnStyleHints(): string {
  return `- 本轮：${pickShape()}。他在认真倾诉或者问了需要讲清楚的事时，按需要说。`;
}

/**
 * Remove roleplay stage directions like "（偷偷看着手机）" while keeping
 * kaomoji such as "(｡•̀ᴗ-)✧" (those contain no Chinese characters).
 */
export function stripStageDirections(text: string): string {
  return text
    // Echoed history timestamps like "[10月22日 周三 09:10]".
    .replace(/\[\d{1,2}月\d{1,2}日[^\]]*\]\s*/g, "")
    // "[图片：…]" / "[表情包：…]" describe what the other person sent; written
    // by her they'd go out as text pretending to be a picture. ("[表情包:12]",
    // a number only, is her real sticker command and stays.)
    .replace(/\[(图片|表情包|视频|语音|QQ表情)([：:](?!\s*\d+\s*\])[^\]\n]*)?\]/g, "")
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
