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

  try {
    const payload = verifyAccessToken(token);
    const [solved, attempted] = await Promise.all([
      db.puzzleAttempt.count({ where: { userId: payload.userId, isCorrect: true } }),
      db.puzzleAttempt.count({ where: { userId: payload.userId } }),
    ]);

    return NextResponse.json({ success: true, solved, attempted });
  } catch {
    return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
  }
}
