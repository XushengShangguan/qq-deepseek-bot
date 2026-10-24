import { NextResponse } from "next/server";
import { recentJournal } from "@/lib/journal";
import { liveOnce } from "@/lib/life";
import { QQ_COMPANION } from "@/lib/qq";
import { getSelf, listPortraits } from "@/lib/self";
import { getTrends } from "@/lib/trends";

export const dynamic = "force-dynamic";

const WEEK_MS = 7 * 24 * 3600 * 1000;

// Debug view of her own life:
//   GET  /api/life   self-portraits (growth log), pending notes, diary, unprompted messages, trends
//   POST /api/life   run one free-time session now and return what she did
export async function GET(req: Request) {
  const companion = new URL(req.url).searchParams.get("companion") || QQ_COMPANION;
  return NextResponse.json({
    companion,
    self: getSelf(companion),
    portraits: listPortraits(companion),
    diary: recentJournal(companion, "diary", WEEK_MS, 50),
    messagesSent: recentJournal(companion, "message", WEEK_MS, 50),
    trends: getTrends(),
  });
}

export async function POST(req: Request) {
  const companion = new URL(req.url).searchParams.get("companion") || QQ_COMPANION;
  return NextResponse.json({ companion, log: await liveOnce(companion) });
}
