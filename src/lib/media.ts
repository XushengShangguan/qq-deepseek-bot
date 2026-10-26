import { getLLM } from "./llm";

// Turns images/stickers into a short text description once, at receive time.
// The description is what gets stored in history, so later turns can keep
// referring to it without re-sending the image, and the chat model itself
// doesn't need vision.

export type ImageKind = "sticker" | "photo";

const MAX_BYTES = 8 * 1024 * 1024;

const PROMPTS: Record<ImageKind, string> = {
  sticker:
    "这是对方在聊天里发来的表情包。用一句中文简短说明：画面是什么、上面写了什么字（如果有）、" +
    "它想表达的情绪或意思（比如无语、撒娇、开心、阴阳怪气）。不超过40字，只输出这句描述。",
  photo:
    "这是对方在聊天里发来的图片。用一两句中文描述画面重点（人物、场景、物品、图里的文字），" +
    "如果像是截图就概括内容。不超过60字，只输出描述。",
};

export function sniffMime(buf: Buffer): string | null {
  if (buf[0] === 0xff && buf[1] === 0xd8) return "image/jpeg";
  if (buf.subarray(0, 4).toString("hex") === "89504e47") return "image/png";
  if (buf.subarray(0, 3).toString("ascii") === "GIF") return "image/gif";
  if (buf.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return null;
}

// Image hosts that refuse requests without their own site as Referer.
const REFERERS: [RegExp, string][] = [
  [/\.hdslb\.com$/, "https://www.bilibili.com/"],
  [/(^|\.)tiebapic\.baidu\.com$|(^|\.)imgsrc\.baidu\.com$/, "https://tieba.baidu.com/"],
];

/** Download an image (at most maxBytes); null if it isn't one or is too big. */
export async function fetchImage(
  url: string,
  maxBytes = MAX_BYTES
): Promise<{ buf: Buffer; mime: string } | null> {
  const host = new URL(url).hostname;
  const referer = REFERERS.find(([re]) => re.test(host))?.[1];
  const res = await fetch(url, {
    signal: AbortSignal.timeout(15000),
    // Some hosts reject requests without a browser-like User-Agent.
    headers: { "User-Agent": "Mozilla/5.0 (Macintosh) companion-app", ...(referer ? { Referer: referer } : {}) },
  });
  if (!res.ok) {
    console.log(`WARNING: image download failed (${res.status})`);
    return null;
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > maxBytes) {
    console.log(`WARNING: image too large (${buf.length} bytes)`);
    return null;
  }
  const mime = sniffMime(buf);
  if (!mime) console.log("WARNING: unsupported image format");
  return mime ? { buf, mime } : null;
}

export function toDataUrl(img: { buf: Buffer; mime: string }): string {
  return `data:${img.mime};base64,${img.buf.toString("base64")}`;
}

async function download(url: string): Promise<string | null> {
  const img = await fetchImage(url);
  return img ? toDataUrl(img) : null;
}

/** e.g. "[表情包：一只猫翻白眼，配字'无语'，表示很无语]"; falls back to a plain placeholder. */
export async function describeImage(url: string | undefined, kind: ImageKind): Promise<string> {
  const label = kind === "sticker" ? "表情包" : "图片";
  if (!url || process.env.IMAGE_UNDERSTANDING === "off") return `[${label}：没加载出来，你看不到内容]`;
  try {
    const llm = await getLLM();
    if (!llm.describeImage) return `[${label}：没加载出来，你看不到内容]`;
    const dataUrl = await download(url);
    if (!dataUrl) return `[${label}：没加载出来，你看不到内容]`;
    const text = (await llm.describeImage(dataUrl, PROMPTS[kind])).replace(/\s+/g, " ").trim();
    return text ? `[${label}：${text}]` : `[${label}]`;
  } catch (err) {
    console.log(`WARNING: could not describe ${label}`, err);
    return `[${label}：没加载出来，你看不到内容]`;
  }
}

// Built-in QQ "face" emoji only carry a numeric id.
const QQ_FACES: Record<string, string> = {
  "0": "惊讶", "1": "撇嘴", "2": "色", "3": "发呆", "4": "得意", "5": "流泪",
  "6": "害羞", "7": "闭嘴", "8": "睡", "9": "大哭", "10": "尴尬", "11": "发怒",
  "12": "调皮", "13": "呲牙", "14": "微笑", "15": "难过", "16": "酷", "18": "抓狂",
  "19": "吐", "20": "偷笑", "21": "可爱", "22": "白眼", "23": "傲慢", "24": "饥饿",
  "25": "困", "26": "惊恐", "27": "流汗", "28": "憨笑", "29": "悠闲", "30": "奋斗",
  "31": "咒骂", "32": "疑问", "33": "嘘", "34": "晕", "36": "衰", "37": "骷髅",
  "38": "敲打", "39": "再见", "41": "发抖", "42": "爱情", "49": "拥抱", "53": "蛋糕",
  "60": "咖啡", "63": "玫瑰", "64": "凋谢", "66": "爱心", "67": "心碎", "74": "太阳",
  "75": "月亮", "76": "赞", "77": "踩", "78": "握手", "79": "胜利", "85": "飞吻",
  "96": "冷汗", "97": "擦汗", "98": "抠鼻", "99": "鼓掌", "100": "糗大了", "101": "坏笑",
  "102": "左哼哼", "103": "右哼哼", "104": "哈欠", "105": "鄙视", "106": "委屈",
  "107": "快哭了", "108": "阴险", "109": "亲亲", "110": "吓", "111": "可怜",
  "116": "示爱", "118": "抱拳", "120": "拳头", "122": "爱你", "123": "NO", "124": "OK",
  "129": "挥手", "173": "泪奔", "174": "无奈", "175": "卖萌", "176": "小纠结",
  "178": "斜眼笑", "179": "doge", "180": "惊喜", "182": "笑哭", "183": "我最美",
  "212": "托腮", "214": "啵啵", "219": "蹭一蹭", "222": "抱抱", "264": "捂脸",
  "265": "辣眼睛", "266": "哦哟", "267": "头秃", "268": "问号脸", "269": "暗中观察",
  "270": "emm", "271": "吃瓜", "272": "呵呵哒", "273": "我酸了", "277": "汪汪",
  "281": "无眼笑", "282": "敬礼", "284": "面无表情", "285": "摸鱼", "287": "哦",
  "289": "睁眼", "307": "喵喵", "311": "打call", "314": "仔细分析", "318": "崇拜",
  "319": "比心", "320": "庆祝", "322": "拒绝", "324": "吃糖", "326": "生气",
};

export function qqFaceName(id: unknown): string {
  const name = QQ_FACES[String(id)];
  return name ? `[QQ表情：${name}]` : "[QQ表情]";
}
