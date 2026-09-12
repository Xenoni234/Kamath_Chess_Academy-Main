import { NextRequest, NextResponse } from "next/server";
import { verifyAccessToken } from "@/lib/auth";
import { db } from "@/lib/db";

export const runtime = "nodejs";

/** One repertoire. Global — any signed-in user may view it. */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const token = request.cookies.get("kca_access_token")?.value;
  if (!token) {
    return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
  }
  let payload;
  try {
    payload = verifyAccessToken(token);
  } catch {
    return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const repertoire = await db.openingRepertoire.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      eco: true,
      colorToPlay: true,
      status: true,
      artifact: true,
      linesJson: true,
      summary: true,
      pdfUrl: true,
      updatedAt: true,
    },
  });
  if (!repertoire) {
    return NextResponse.json({ success: false, message: "Not found" }, { status: 404 });
  }

  // `hasPdf` has to come from the stored bytes, not from `pdfUrl`: /tmp is wiped on every
  // redeploy while the path column survives, so the old check kept offering a download
  // button for a file that was no longer there. A COUNT answers it without pulling the
  // blob across the wire, which selecting `pdf` would.
  const [saved, withPdf] = await Promise.all([
    db.savedOpening.findUnique({
      where: { userId_repertoireId: { userId: payload.userId, repertoireId: id } },
      select: { id: true },
    }),
    db.openingRepertoire.count({ where: { id, pdf: { not: null } } }),
  ]);

  const { pdfUrl, ...rest } = repertoire;
  return NextResponse.json({
    success: true,
    repertoire: {
      ...rest,
      guide: repertoire.summary,
      lines: repertoire.linesJson,
      hasPdf: withPdf > 0 || Boolean(pdfUrl),
      saved: Boolean(saved),
    },
  });
}
