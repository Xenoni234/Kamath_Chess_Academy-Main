import { NextRequest, NextResponse } from "next/server";
import { verifyAccessToken } from "@/lib/auth";
import { db } from "@/lib/db";
import { writeAuditLog } from "@/lib/audit";
import { resolveOpening } from "@/lib/opening/eco";
import { enqueueOpening } from "@/lib/queue/queues";

export const runtime = "nodejs";

/** Rebuild a repertoire in place (global — anyone may trigger a refresh). */
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
  const existing = await db.openingRepertoire.findUnique({
    where: { id },
    select: { id: true, name: true, colorToPlay: true },
  });
  if (!existing) {
    return NextResponse.json({ success: false, message: "Not found" }, { status: 404 });
  }

  // TOCTOU-safe claim: only (re)start when not already in flight.
  const claimed = await db.openingRepertoire.updateMany({
    where: { id, status: { notIn: ["pending", "processing"] } },
    data: { status: "pending", version: { increment: 1 } },
  });
  if (claimed.count === 0) {
    return NextResponse.json({ success: false, message: "This repertoire is already building." }, { status: 409 });
  }

  const resolved = resolveOpening(existing.name);
  if (!resolved) {
    await db.openingRepertoire.update({ where: { id }, data: { status: "failed" } });
    return NextResponse.json({ success: false, message: "Could not re-resolve this opening." }, { status: 422 });
  }

  await writeAuditLog({
    action: "opening.regenerate",
    userId: payload.userId,
    metadata: { repertoireId: id, opening: existing.name },
    request,
  });

  await enqueueOpening({
    repertoireId: id,
    name: existing.name,
    colorToPlay: existing.colorToPlay === "black" ? "black" : "white",
    rootUci: resolved.uci,
    requestedById: payload.userId,
  });

  return NextResponse.json({ success: true, status: "pending" }, { status: 202 });
}
