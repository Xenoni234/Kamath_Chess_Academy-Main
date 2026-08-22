import { NextRequest, NextResponse } from "next/server";
import { verifyAccessToken } from "@/lib/auth";
import { db } from "@/lib/db";

export const runtime = "nodejs";

/** Add this repertoire to the caller's personal library. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
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
  const exists = await db.openingRepertoire.findUnique({ where: { id }, select: { id: true } });
  if (!exists) {
    return NextResponse.json({ success: false, message: "Not found" }, { status: 404 });
  }

  await db.savedOpening.upsert({
    where: { userId_repertoireId: { userId: payload.userId, repertoireId: id } },
    create: { userId: payload.userId, repertoireId: id },
    update: {},
  });
  return NextResponse.json({ success: true, saved: true });
}

/** Remove it from the caller's library. */
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
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
  await db.savedOpening
    .delete({ where: { userId_repertoireId: { userId: payload.userId, repertoireId: id } } })
    .catch(() => {});
  return NextResponse.json({ success: true, saved: false });
}
