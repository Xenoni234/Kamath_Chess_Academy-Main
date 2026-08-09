import { NextRequest, NextResponse } from "next/server";
import { verifyAccessToken } from "@/lib/auth";
import { db } from "@/lib/db";

export const runtime = "nodejs";

/** The caller's own reports, newest first. */
export async function GET(request: NextRequest) {
  const token = request.cookies.get("kca_access_token")?.value;

  if (!token) {
    return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
  }

  try {
    const payload = verifyAccessToken(token);
    const reports = await db.gameReport.findMany({
      where: { userId: payload.userId },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: {
        id: true,
        status: true,
        lichessId: true,
        chesscomId: true,
        gamesAnalyzed: true,
        summary: true,
        emailSentAt: true,
        createdAt: true,
      },
    });

    return NextResponse.json({ success: true, reports });
  } catch {
    return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
  }
}
