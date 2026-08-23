import { NextRequest, NextResponse } from "next/server";
import { verifyAccessToken } from "@/lib/auth";
import { db } from "@/lib/db";
import { writeAuditLog } from "@/lib/audit";
import { createProfileSchema } from "@/lib/validations/phase4";

// `enqueueProfile` is deliberately NOT imported at module scope. It reaches
// runProfileJob and runReportJob, which pull in puppeteer, neo4j-driver, the
// Anthropic SDK and resend — several seconds of module loading. GET on this
// route is a single findMany and has no business paying for that, so the import
// happens inside POST, which actually needs it.

export const runtime = "nodejs";

/** The caller's own opponent dossiers, newest first. */
export async function GET(request: NextRequest) {
  const token = request.cookies.get("kca_access_token")?.value;
  if (!token) {
    return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
  }
  try {
    const payload = verifyAccessToken(token);
    const profiles = await db.opponentProfile.findMany({
      where: { requestedById: payload.userId },
      orderBy: { createdAt: "desc" },
      take: 50,
      select: {
        id: true,
        handle: true,
        source: true,
        colorToPlay: true,
        status: true,
        gamesAnalyzed: true,
        createdAt: true,
        // `handle`/`source` are still returned above: pre-multi-account rows
        // have no `accounts` rows at all, and an older client reads them.
        accounts: {
          select: { handle: true, source: true, position: true },
          orderBy: { position: "asc" },
        },
      },
    });
    return NextResponse.json({ success: true, profiles });
  } catch {
    return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
  }
}

/** Start a profiling run against an opponent handle. */
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

  const parsed = createProfileSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        success: false,
        message: "Invalid request payload",
        errors: parsed.error.flatten().fieldErrors,
      },
      { status: 400 },
    );
  }

  const { accounts, colorToPlay, fideId, playerName, pastedPgn, forcedColor } = parsed.data;
  const primary = accounts[0];

  // A dossier now pulls up to 1000 games and runs a pool of engines. Several at
  // once is the incident already documented on the regenerate route — 48 engines
  // on 10 cores and a 13.8s login — except that guard cannot help here, because
  // every POST creates a fresh row and has nothing to contend over.
  const inFlight = await db.opponentProfile.count({
    where: { requestedById: payload.userId, status: { in: ["pending", "processing"] } },
  });
  if (inFlight >= 2) {
    return NextResponse.json(
      {
        success: false,
        message: "You already have two dossiers building. Wait for one to finish, then try again.",
      },
      { status: 429 },
    );
  }

  const profile = await db.opponentProfile.create({
    data: {
      requestedById: payload.userId,
      // Denormalised primary — the invariant is that it equals position 0.
      handle: primary.handle,
      source: primary.source,
      colorToPlay,
      fideId: fideId || null,
      playerName: playerName || null,
      pastedPgn: pastedPgn || null,
      status: "pending",
      accounts: {
        create: accounts.map((account, position) => ({ ...account, position })),
      },
    },
    select: { id: true },
  });

  await writeAuditLog({
    action: "second.profile.create",
    userId: payload.userId,
    metadata: { profileId: profile.id, accounts, colorToPlay },
    request,
  });

  const { enqueueProfile } = await import("@/lib/queue/queues");
  await enqueueProfile({
    profileId: profile.id,
    requestedById: payload.userId,
    accounts,
    handle: primary.handle,
    source: primary.source,
    colorToPlay,
    fideId: fideId || undefined,
    playerName: playerName || undefined,
    pastedPgn: pastedPgn || undefined,
    forcedColor: forcedColor || undefined,
  });

  return NextResponse.json({ success: true, profileId: profile.id }, { status: 201 });
}
