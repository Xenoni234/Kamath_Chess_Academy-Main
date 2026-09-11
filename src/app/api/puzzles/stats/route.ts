import { NextRequest, NextResponse } from "next/server";
import { verifyAccessToken } from "@/lib/auth";
import { db } from "@/lib/db";

// Per-user puzzle stats. `solved` = distinct puzzles whose latest attempt was
// correct (attempts are upserted one row per user+puzzle).
export async function GET(request: NextRequest) {
  const token = request.cookies.get("kca_access_token")?.value;

  if (!token) {
    return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
  }

  let payload: ReturnType<typeof verifyAccessToken>;
  try {
    payload = verifyAccessToken(token);
  } catch {
    return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
  }

  // A failure below here is a server fault, not an auth failure. Returning 401
  // for it used to log every user out on a single database blip, silently.
  try {
    const [solved, attempted] = await Promise.all([
      db.puzzleAttempt.count({ where: { userId: payload.userId, isCorrect: true } }),
      db.puzzleAttempt.count({ where: { userId: payload.userId } }),
    ]);

    return NextResponse.json({ success: true, solved, attempted });
  } catch (error) {
    console.error("[puzzles/stats] GET failed:", error);
    return NextResponse.json({ success: false, message: "Something went wrong." }, { status: 500 });
  }
}
