import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// Docker healthcheck target. Any request also makes Next.js run
// instrumentation.ts, which starts her free time and the offline watchdog.
export function GET() {
  return NextResponse.json({ ok: true });
}
