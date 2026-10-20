import { NextResponse } from "next/server";
import { handleIncoming, verifySignature, type OneBotEvent } from "@/lib/qq";

// NapCat posts every OneBot event here (its "HTTP client" network config).
// We answer immediately with an empty body (= no quick action) and send the
// actual reply later through NapCat's HTTP API, since generation takes seconds.
export async function POST(req: Request) {
  const raw = await req.text();
  if (!verifySignature(raw, req.headers.get("x-signature"))) {
    console.log("WARNING: QQ webhook signature mismatch; check QQ_TOKEN");
    return NextResponse.json({ Message: "bad signature" }, { status: 401 });
  }

  let event: OneBotEvent;
  try {
    event = JSON.parse(raw);
  } catch {
    return NextResponse.json({ Message: "invalid JSON" }, { status: 400 });
  }

  handleIncoming(event);
  return new Response(null, { status: 204 });
}
