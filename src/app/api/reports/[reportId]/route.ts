import { NextRequest, NextResponse } from "next/server";
import { verifyAccessToken } from "@/lib/auth";
import { db } from "@/lib/db";

export async function GET(request: NextRequest, context: { params: Promise<{ reportId: string }> }) {
  const token = request.cookies.get("kca_access_token")?.value;

  if (!token) {
    return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
  }

  try {
    const payload = verifyAccessToken(token);
    const { reportId } = await context.params;
    const report = await db.gameReport.findUnique({
      where: { id: reportId },
      select: { userId: true, status: true, gamesAnalyzed: true, pdfUrl: true, createdAt: true },
    });

    if (!report || report.userId !== payload.userId) {
      return NextResponse.json({ success: false, message: "Report not found" }, { status: 404 });
    }

    return NextResponse.json({
      status: report.status,
      gamesAnalyzed: report.gamesAnalyzed,
      pdfUrl: report.pdfUrl,
      createdAt: report.createdAt,
    });
  } catch {
    return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
  }
}
