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
