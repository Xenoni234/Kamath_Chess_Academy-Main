import { NextRequest, NextResponse } from "next/server";
import { verifyAccessToken } from "@/lib/auth";
import { redis } from "@/lib/redis";
import { previewPastedPgn } from "@/lib/second/pgnImport";
import { pgnPreviewSchema, MAX_PASTED_GAMES } from "@/lib/validations/phase4";

export const runtime = "nodejs";

/**
 * Parse a pasted PGN block and report, per game, whether it can be used and (if
 * not) why — WITHOUT running a profile. Reuses `previewPastedPgn`, which wraps the
 * exact `importPastedPgn` the job uses, so what the user sees here is what the
 * profiler will actually ingest. Pure parse; lightly rate-limited like the
 * move-explanation route since the client calls it as the user types.
 */
export async function POST(request: NextRequest) {
  const token = request.cookies.get("kca_access_token")?.value;
  if (!token) {
    return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
  }

  try {
    const payload = verifyAccessToken(token);

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ success: false, message: "Invalid request body" }, { status: 400 });
    }

    const parsed = pgnPreviewSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, message: "Invalid request payload", errors: parsed.error.flatten().fieldErrors },
        { status: 400 },
      );
    }

    const key = `rate:pgnpreview:${payload.userId}`;
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, 60);
    if (count > 30) {
      return NextResponse.json({ success: false, message: "Rate limit exceeded" }, { status: 429 });
    }

    const { pastedPgn, playerName, fideId, forcedColor } = parsed.data;
    const { accepted, rejected, total } = previewPastedPgn(pastedPgn, {
      playerName,
      playerFideId: fideId,
      forcedColor,
      max: MAX_PASTED_GAMES,
    });

    return NextResponse.json({ success: true, accepted, rejected, total });
  } catch {
    return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
  }
}
