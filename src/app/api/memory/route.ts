import { NextResponse } from "next/server";
import { countMessages, listMemories } from "@/lib/memory";
import { getRecentEvents, getRelationshipState } from "@/lib/relationship";

export const dynamic = "force-dynamic";

// Debug view of what a companion remembers:
//   /api/memory?companion=Mina              (browser user)
//   /api/memory?companion=Mina&user=qq:123  (a QQ user)
export async function GET(req: Request) {
  const url = new URL(req.url);
  const companion = url.searchParams.get("companion");
  if (!companion) {
    return NextResponse.json({ Message: "Missing ?companion=" }, { status: 400 });
  }
  const session = {
    userId: url.searchParams.get("user") || "web:local",
    companion,
  };
  return NextResponse.json({
    session,
    messageCount: countMessages(session),
    relationship: getRelationshipState(session),
    recentEvents: getRecentEvents(session, 20),
    memories: listMemories(session),
  });
}
