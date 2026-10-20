import { StreamingTextResponse } from "ai";
import { NextResponse } from "next/server";
import { handleMessageStream } from "@/lib/conversation";

// Browser chat channel. Local, single-user: no login, fixed web user id.
const WEB_USER_ID = "web:local";
const WEB_USER_NAME = process.env.WEB_USER_NAME || "你";

export async function POST(req: Request) {
  const { prompt } = await req.json();
  const companion = req.headers.get("name");
  if (!companion || typeof prompt !== "string" || !prompt.trim()) {
    return NextResponse.json(
      { Message: "Missing companion name or prompt" },
      { status: 400 }
    );
  }

  try {
    const stream = await handleMessageStream({
      userId: WEB_USER_ID,
      userName: WEB_USER_NAME,
      companion,
      text: prompt.trim(),
    });
    return new StreamingTextResponse(stream);
  } catch (err) {
    console.error("chat setup failed", err);
    return NextResponse.json(
      { Message: err instanceof Error ? err.message : "Chat failed" },
      { status: 500 }
    );
  }
}
