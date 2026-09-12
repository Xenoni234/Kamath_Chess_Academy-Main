import { NextRequest, NextResponse } from "next/server";
import { verifyAccessToken } from "@/lib/auth";
import { db } from "@/lib/db";

export const runtime = "nodejs";

export async function GET(request: NextRequest, context: { params: Promise<{ reportId: string }> }) {
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
    const { reportId } = await context.params;
    const report = await db.gameReport.findUnique({
      where: { id: reportId },
      select: {
        userId: true,
        status: true,
        gamesAnalyzed: true,
        summary: true,
        emailSentAt: true,
        createdAt: true,
      },
    });

    if (!report || report.userId !== payload.userId) {
      return NextResponse.json({ success: false, message: "Report not found" }, { status: 404 });
    }

    // pdfUrl is a server-side /tmp path and is deliberately not exposed —
    // clients download through /api/reports/[reportId]/download instead.
    return NextResponse.json({
      success: true,
      status: report.status,
      gamesAnalyzed: report.gamesAnalyzed,
      summary: report.summary,
      emailSentAt: report.emailSentAt,
      createdAt: report.createdAt,
    });
  } catch (error) {
    console.error("[reports/[reportId]] GET failed:", error);
    return NextResponse.json({ success: false, message: "Something went wrong." }, { status: 500 });
  }
}

/**
 * Delete one of your own reports, PDF and all.
 *
 * Ownership is checked inside the delete itself rather than with a read-then-write: two
 * clicks on the button would otherwise both pass the read and the second would throw on a
 * row that no longer exists. `deleteMany` with the userId in the filter is atomic, cannot
 * touch anyone else's row, and reports "0 deleted" instead of throwing.
 *
 * 404 for "not yours" as well as "not found", so report ids cannot be probed.
 */
export async function DELETE(request: NextRequest, context: { params: Promise<{ reportId: string }> }) {
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

  try {
    const { reportId } = await context.params;

    const { count } = await db.gameReport.deleteMany({
      where: { id: reportId, userId: payload.userId },
    });

    if (count === 0) {
      return NextResponse.json({ success: false, message: "Report not found" }, { status: 404 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("[reports/[reportId]] DELETE failed:", error);
    return NextResponse.json({ success: false, message: "Something went wrong." }, { status: 500 });
  }
}
