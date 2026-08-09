import fs from "node:fs/promises";
import { NextRequest, NextResponse } from "next/server";
import { verifyAccessToken } from "@/lib/auth";
import { db } from "@/lib/db";

export const runtime = "nodejs";

/**
 * Streams a finished report's PDF.
 *
 * The file lives in /tmp, which is ephemeral and per-instance — a restart or a
 * different server drops it. The emailed attachment remains the durable copy,
 * so a 404 here is expected for older reports rather than an error.
 */
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ reportId: string }> },
) {
  const token = request.cookies.get("kca_access_token")?.value;

  if (!token) {
    return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
  }

  try {
    const payload = verifyAccessToken(token);
    const { reportId } = await context.params;

    const report = await db.gameReport.findUnique({ where: { id: reportId } });

    // Same treatment for "not yours" and "not found" so the route cannot be
    // used to probe which report ids exist.
    if (!report || report.userId !== payload.userId) {
      return NextResponse.json({ success: false, message: "Not found" }, { status: 404 });
    }

    if (report.status !== "complete" || !report.pdfUrl) {
      return NextResponse.json({ success: false, message: "Report is not ready" }, { status: 404 });
    }

    let pdf: Buffer;
    try {
      pdf = await fs.readFile(report.pdfUrl);
    } catch {
      return NextResponse.json(
        { success: false, message: "This report's file has expired — check your email for the copy we sent." },
        { status: 404 },
      );
    }

    return new NextResponse(new Uint8Array(pdf), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="kca-report-${reportId}.pdf"`,
        "Cache-Control": "private, no-store",
      },
    });
  } catch {
    return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
  }
}
