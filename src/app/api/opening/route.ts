import { NextRequest, NextResponse } from "next/server";
import { verifyAccessToken } from "@/lib/auth";
import { db } from "@/lib/db";
import { writeAuditLog } from "@/lib/audit";
import { resolveOpening, searchOpenings, openingSlug } from "@/lib/opening/eco";
import { createOpeningSchema } from "@/lib/validations/phase5";

// enqueueOpening reaches runOpeningJob (puppeteer, the AI SDK, the engine) — kept
// out of module scope so GET pays nothing for it, imported inside POST.

export const runtime = "nodejs";

/** Cached/complete repertoires plus the caller's saved shortcuts. */
export async function GET(request: NextRequest) {
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

  const [recent, saved] = await Promise.all([
    db.openingRepertoire.findMany({
      where: { status: "complete" },
      orderBy: { updatedAt: "desc" },
      take: 30,
      select: { id: true, name: true, eco: true, colorToPlay: true, status: true, updatedAt: true },
    }),
    db.savedOpening.findMany({
      where: { userId: payload.userId },
      orderBy: { createdAt: "desc" },
      select: {
        repertoireId: true,
        repertoire: { select: { id: true, name: true, eco: true, colorToPlay: true, status: true } },
      },
    }),
  ]);

  return NextResponse.json({ success: true, repertoires: recent, saved: saved.map((s) => s.repertoire) });
}

/** Build (or return the cached) repertoire for a named opening. */
export async function POST(request: NextRequest) {
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

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, message: "Invalid request body" }, { status: 400 });
  }

  const parsed = createOpeningSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, message: "Invalid request payload", errors: parsed.error.flatten().fieldErrors },
      { status: 400 },
    );
  }

  const { opening, colorToPlay } = parsed.data;
  const resolved = resolveOpening(opening);
  if (!resolved) {
    return NextResponse.json(
      {
        success: false,
        message: `Couldn't find an opening matching "${opening}".`,
        candidates: searchOpenings(opening, 6).map((c) => ({ name: c.name, eco: c.eco })),
      },
      { status: 404 },
    );
  }

  const slug = openingSlug(resolved.name, colorToPlay);

  // Global cache: if it's already built or building, hand back that row.
  const existing = await db.openingRepertoire.findUnique({ where: { slug }, select: { id: true, status: true } });
  if (existing && existing.status !== "failed") {
    return NextResponse.json({ success: true, repertoireId: existing.id, status: existing.status });
  }

  // Bound global engine load — the cache means this is rarely hit.
  const inFlight = await db.openingRepertoire.count({ where: { status: { in: ["pending", "processing"] } } });
  if (inFlight >= 4) {
    return NextResponse.json(
      { success: false, message: "Several repertoires are building right now. Try again in a minute." },
      { status: 429 },
    );
  }

  // Create, or reclaim a previously failed row (same slug).
  const row = await db.openingRepertoire.upsert({
    where: { slug },
    create: { slug, name: resolved.name, eco: resolved.eco || null, colorToPlay, status: "pending" },
    update: { status: "pending", version: { increment: 1 } },
    select: { id: true },
  });

  await writeAuditLog({
    action: "opening.generate",
    userId: payload.userId,
    metadata: { repertoireId: row.id, opening: resolved.name, colorToPlay },
    request,
  });

  const { enqueueOpening } = await import("@/lib/queue/queues");
  await enqueueOpening({
    repertoireId: row.id,
    name: resolved.name,
    colorToPlay,
    rootUci: resolved.uci,
    requestedById: payload.userId,
  });

  return NextResponse.json({ success: true, repertoireId: row.id, status: "pending" }, { status: 201 });
}
