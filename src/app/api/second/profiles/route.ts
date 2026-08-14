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

  const { handle, source, colorToPlay, fideId } = parsed.data;

  const profile = await db.opponentProfile.create({
    data: {
      requestedById: payload.userId,
      handle,
      source,
      colorToPlay,
      fideId: fideId || null,
      status: "pending",
    },
    select: { id: true },
  });

  await writeAuditLog({
    action: "second.profile.create",
    userId: payload.userId,
    metadata: { profileId: profile.id, handle, source, colorToPlay },
    request,
  });

  const { enqueueProfile } = await import("@/lib/queue/queues");
  await enqueueProfile({
    profileId: profile.id,
    requestedById: payload.userId,
    handle,
    source,
    colorToPlay,
    fideId: fideId || undefined,
  });

  return NextResponse.json({ success: true, profileId: profile.id }, { status: 201 });
}
