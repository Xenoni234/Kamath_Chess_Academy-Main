import fs from "node:fs/promises";
import { NextRequest, NextResponse } from "next/server";
import { verifyAccessToken } from "@/lib/auth";
import { db } from "@/lib/db";

export const runtime = "nodejs";

/**
 * Streams a repertoire's PDF. Global — any signed-in user may download it.
 *
 * The file lives in /tmp — ephemeral and per-instance — so a 404 for an older
 * repertoire is expected rather than an error (regenerate to restore it).
 */
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const token = request.cookies.get("kca_access_token")?.value;
  if (!token) {
    return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
  }

  try {
    verifyAccessToken(token);
    const { id } = await context.params;

    const repertoire = await db.openingRepertoire.findUnique({
      where: { id },
      select: { name: true, pdfUrl: true },
    });

    if (!repertoire) {
      return NextResponse.json({ success: false, message: "Not found" }, { status: 404 });
    }
    if (!repertoire.pdfUrl) {
      return NextResponse.json({ success: false, message: "Repertoire is not ready" }, { status: 404 });
    }

    let pdf: Buffer;
    try {
      pdf = await fs.readFile(repertoire.pdfUrl);
    } catch {
      return NextResponse.json(
        { success: false, message: "This repertoire's file has expired — regenerate it to get a fresh copy." },
        { status: 404 },
      );
    }

    const safeName = repertoire.name.replace(/[^a-zA-Z0-9_-]/g, "-").replace(/-+/g, "-").slice(0, 60) || "opening";

    return new NextResponse(new Uint8Array(pdf), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="kca-opening-${safeName}.pdf"`,
        "Cache-Control": "private, no-store",
      },
    });
  } catch {
    return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
  }
}
