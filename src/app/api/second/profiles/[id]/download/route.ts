import fs from "node:fs/promises";
import { NextRequest, NextResponse } from "next/server";
import { verifyAccessToken } from "@/lib/auth";
import { db } from "@/lib/db";

export const runtime = "nodejs";

/**
 * Streams a dossier's PDF. Owner-only.
 *
 * Like the game-report download, the file lives in /tmp — ephemeral and
 * per-instance — so a 404 for an older dossier is expected rather than an error.
 */
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const token = request.cookies.get("kca_access_token")?.value;
  if (!token) {
    return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
  }

  try {
    const payload = verifyAccessToken(token);
    const { id } = await context.params;

    const profile = await db.opponentProfile.findUnique({
      where: { id },
      select: {
        requestedById: true,
        handle: true,
        repertoires: { orderBy: { createdAt: "desc" }, take: 1, select: { pdfUrl: true } },
      },
    });

    if (!profile || profile.requestedById !== payload.userId) {
      return NextResponse.json({ success: false, message: "Not found" }, { status: 404 });
    }

    const pdfUrl = profile.repertoires[0]?.pdfUrl;
    if (!pdfUrl) {
      return NextResponse.json({ success: false, message: "Dossier is not ready" }, { status: 404 });
    }

    let pdf: Buffer;
    try {
      pdf = await fs.readFile(pdfUrl);
    } catch {
      return NextResponse.json(
        { success: false, message: "This dossier's file has expired — regenerate it to get a fresh copy." },
        { status: 404 },
      );
    }

    const safeHandle = profile.handle.replace(/[^a-zA-Z0-9_-]/g, "") || "opponent";

    return new NextResponse(new Uint8Array(pdf), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="kca-dossier-${safeHandle}.pdf"`,
        "Cache-Control": "private, no-store",
      },
    });
  } catch {
    return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
  }
}
