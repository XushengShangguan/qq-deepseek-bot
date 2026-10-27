import { getDb } from "./db";
import { addJournal, recentJournal } from "./journal";
import { isOnline, QQ_COMPANION } from "./qq";

// Tells you when the bot QQ account gets kicked offline (and when it's back),
// through a channel that doesn't depend on QQ:
//   SERVERCHAN_SENDKEY  Server酱 (WeChat push), https://sct.ftqq.com
//   BARK_URL            Bark (iPhone push), e.g. https://api.day.app/<your key>
// Checks every CHECK_MS; only alerts after two offline checks in a row, so a
// NapCat restart doesn't page you.

const CHECK_MS = 2 * 60 * 1000;
const SERVERCHAN_SENDKEY = process.env.SERVERCHAN_SENDKEY || "";
const BARK_URL = (process.env.BARK_URL || "").replace(/\/$/, "");

export async function notify(title: string, body: string) {
  const sends: Promise<unknown>[] = [];
  if (SERVERCHAN_SENDKEY) {
    sends.push(
      fetch(`https://sctapi.ftqq.com/${SERVERCHAN_SENDKEY}.send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, desp: body }),
        signal: AbortSignal.timeout(10_000),
      })
    );
  }
  if (BARK_URL) {
    sends.push(
      fetch(`${BARK_URL}/${encodeURIComponent(title)}/${encodeURIComponent(body)}?group=companion`, {
        signal: AbortSignal.timeout(10_000),
      })
    );
  }
  for (const r of await Promise.allSettled(sends)) {
    if (r.status === "rejected") console.log("WARNING: alert not delivered:", String(r.reason));
  }
}

/**
 * Next.js runs more than one server process, each with its own watchdog.
 * The last recorded state lives in the database; whoever records a change
 * first sends the alert, the others see it's already recorded.
 */
function recordState(state: "online" | "offline"): boolean {
  const db = getDb();
  return db
    .transaction(() => {
      const last = recentJournal(QQ_COMPANION, "qq-status", 365 * 24 * 3600 * 1000, 1)[0];
      if ((last?.content ?? "online") === state) return false;
      addJournal(QQ_COMPANION, "qq-status", state);
      return true;
    })
    .immediate();
}

const state = globalThis as unknown as { watchdogTimer?: NodeJS.Timeout; watchdogMisses?: number };

async function check() {
  if (await isOnline()) {
    state.watchdogMisses = 0;
    if (recordState("online")) {
      console.log("INFO: bot QQ back online");
      await notify("大肥鱼上线了", "QQ 小号已重新登录，可以正常聊天了。");
    }
    return;
  }
  state.watchdogMisses = (state.watchdogMisses ?? 0) + 1;
  if (state.watchdogMisses >= 2 && recordState("offline")) {
    console.log("WARNING: bot QQ offline, alert sent");
    await notify(
      "大肥鱼掉线了",
      "QQ 小号被踢下线，她现在收不到消息。\n\n" +
        "重新登录：在 Mac 终端运行 `ssh -L 6099:127.0.0.1:6099 root@服务器IP`，" +
        "然后打开 http://127.0.0.1:6099/webui 用小号扫码。"
    );
  }
}

/** Start the offline watchdog once per server process (needs a push channel). */
export function startWatchdog() {
  if (state.watchdogTimer) return;
  if (!SERVERCHAN_SENDKEY && !BARK_URL) {
    console.log("INFO: offline alerts off (set SERVERCHAN_SENDKEY or BARK_URL)");
    return;
  }
  console.log("INFO: offline alerts on");
  state.watchdogTimer = setInterval(() => {
    check().catch((err) => console.error("watchdog check failed", err));
  }, CHECK_MS);
}
