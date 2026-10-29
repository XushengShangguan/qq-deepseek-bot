// The companion lives in her own timezone (her persona's city), which can
// differ from where the user is. Both clocks go into the prompt.

/** Where the companion lives. */
export const COMPANION_TIMEZONE = process.env.COMPANION_TIMEZONE || "Asia/Shanghai";

/** Default for users with no explicit timezone: this machine's timezone. */
export const DEFAULT_USER_TIMEZONE =
  process.env.USER_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone;

const CITY_NAMES: Record<string, string> = {
  "Asia/Shanghai": "上海",
  "Asia/Chongqing": "重庆",
  "Asia/Hong_Kong": "香港",
  "Asia/Taipei": "台北",
  "Asia/Tokyo": "东京",
  "Asia/Seoul": "首尔",
  "Asia/Singapore": "新加坡",
  "Europe/London": "伦敦",
  "Europe/Paris": "巴黎",
  "Europe/Berlin": "柏林",
  "America/New_York": "纽约",
  "America/Los_Angeles": "洛杉矶",
  "Australia/Sydney": "悉尼",
};

export function cityName(tz: string) {
  return CITY_NAMES[tz] ?? tz;
}

/** e.g. "2026年10月21日 星期三 00:15" in the given timezone. */
export function formatNow(tz: string, now = new Date()) {
  return now.toLocaleString("zh-CN", {
    timeZone: tz,
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "long",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
}

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

/** Calendar parts of a moment in a timezone. */
function partsIn(ts: number, tz: string) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz, year: "numeric", month: "numeric", day: "numeric",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).formatToParts(new Date(ts)).map((x) => [x.type, x.value])
  );
  const y = Number(p.year), m = Number(p.month), d = Number(p.day);
  return { y, m, d, hh: p.hour, mm: p.minute, weekday: WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()] };
}

/** Hour of the day (0-23) in `tz`. */
export function hourIn(tz: string, ts = Date.now()) {
  return Number(partsIn(ts, tz).hh);
}

/** Same calendar day in `tz`? */
export function sameDay(a: number, b: number, tz: string) {
  const x = partsIn(a, tz), y = partsIn(b, tz);
  return x.y === y.y && x.m === y.m && x.d === y.d;
}

/** e.g. "10月21日 周二 23:31". */
export function formatStamp(ts: number, tz: string) {
  const p = partsIn(ts, tz);
  return `${p.m}月${p.d}日 ${p.weekday} ${p.hh}:${p.mm}`;
}

/** e.g. "10 小时" / "2 天" / "40 分钟". */
export function formatGap(ms: number) {
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min} 分钟`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} 小时`;
  return `${Math.round(h / 24)} 天`;
}

/** "今天 10月22日 周三；昨天 10月21日 周二；…" relative-day cheat sheet. */
export function describeNearbyDays(tz: string, now = Date.now()) {
  const DAY = 86400000;
  const label = (ts: number) => {
    const p = partsIn(ts, tz);
    return `${p.m}月${p.d}日 ${p.weekday}`;
  };
  return [
    ["前天", -2], ["昨天", -1], ["今天", 0], ["明天", 1], ["后天", 2],
  ].map(([name, off]) => `${name} ${label(now + (off as number) * DAY)}`).join("；");
}

export function formatDate(ts: number, tz: string) {
  return new Date(ts).toLocaleDateString("zh-CN", { timeZone: tz });
}

function offsetMinutes(tz: string, now = new Date()) {
  const local = new Date(now.toLocaleString("en-US", { timeZone: tz }));
  const utc = new Date(now.toLocaleString("en-US", { timeZone: "UTC" }));
  return Math.round((local.getTime() - utc.getTime()) / 60000);
}

/** e.g. "比你那边快1小时"; empty when both are in the same time. */
export function describeDifference(userTz: string, companionTz: string) {
  const diff = (offsetMinutes(userTz) - offsetMinutes(companionTz)) / 60;
  if (diff === 0) return "";
  const hours = Number.isInteger(diff) ? `${Math.abs(diff)}` : Math.abs(diff).toFixed(1);
  return diff > 0 ? `比你那边快${hours}小时` : `比你那边慢${hours}小时`;
}

/**
 * A moment she names in her own words, read in `tz`: "3小时后", "40分钟后",
 * "21:00", "明天 9点半", "10-30 08:00", "2026-11-01 20:00". A bare time that
 * has already passed today means tomorrow. Null if it can't be read.
 */
export function parseWhen(text: string, tz: string, now = Date.now()): number | null {
  const s = text.trim();
  const rel = s.match(/^(\d+(?:\.\d+)?)\s*(分钟|小时|天)后$/);
  if (rel) return now + Number(rel[1]) * { 分钟: 60_000, 小时: 3_600_000, 天: 86_400_000 }[rel[2] as "分钟"];

  const p = partsIn(now, tz);
  // Minutes between this zone's wall clock and UTC, right now.
  const offset = Date.UTC(p.y, p.m - 1, p.d, Number(p.hh), Number(p.mm)) - Math.floor(now / 60_000) * 60_000;
  const t = s.match(/(\d{1,2})\s*(?:[:：]\s*(\d{2})|点\s*(半|(\d{1,2})\s*分?)?)\s*$/);
  if (!t) return null;
  const hh = Number(t[1]);
  const mm = t[2] ? Number(t[2]) : t[3] === "半" ? 30 : t[4] ? Number(t[4]) : 0;
  if (hh > 23 || mm > 59) return null;
  const head = s.slice(0, t.index).trim();

  let y = p.y, m = p.m, d = p.d;
  const date = head.match(/(?:(\d{4})\s*[-/年]\s*)?(\d{1,2})\s*[-/月]\s*(\d{1,2})\s*日?/);
  if (date) {
    y = date[1] ? Number(date[1]) : y;
    m = Number(date[2]);
    d = Number(date[3]);
  } else if (/后天/.test(head)) d += 2;
  else if (/明天|明早|明晚/.test(head)) d += 1;
  else if (head && !/今天|今晚|今早|晚上|早上|下午|上午|中午/.test(head)) return null;

  // "晚上8点" means 20:00.
  const hour = /晚|下午/.test(head) && hh < 12 ? hh + 12 : hh;
  let at = Date.UTC(y, m - 1, d, hour, mm) - offset;
  if (!date && !head && at <= now) at += 86_400_000;
  return at;
}
