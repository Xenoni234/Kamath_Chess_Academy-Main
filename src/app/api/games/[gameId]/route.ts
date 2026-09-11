import { NextRequest, NextResponse } from "next/server";
import { verifyAccessToken } from "@/lib/auth";
import { canViewStudent } from "@/lib/authz";
import { db } from "@/lib/db";
import { writeAuditLog } from "@/lib/audit";

export const runtime = "nodejs";

/**
 * One game, for someone entitled to see it.
 *
 * The verified payload used to be discarded, so any logged-in user could read any
 * game by id — including `records`, which carries both players' rating movement.
 * That was tightened to participants only.
 *
 * Participants-only turned out to be too tight: a coach reviewing a student's
 * game is neither the white nor the black player, so annotating a student's game
 * was impossible — the fetch 404'd. Access now also runs through
 * `canViewStudent`, the same helper every other student-scoped route uses, which
 * admits the student themselves, their parent, their coach and academy staff, and
 * nobody else.
 *
 * A read by anyone who was NOT in the game is written to the audit log, because
 * at that point it is one person looking at another person's record — the same
 * rule `students/[id]/overview` follows.
 */
export async function GET(request: NextRequest, context: { params: Promise<{ gameId: string }> }) {
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

  const { gameId } = await context.params;
  const game = await db.game.findUnique({
    where: { id: gameId },
    include: {
      whiteUser: { select: { id: true, username: true } },
      blackUser: { select: { id: true, username: true } },
      records: {
        select: { userId: true, ratingBefore: true, ratingAfter: true, result: true },
      },
    },
  });

  // 404 rather than 403 for a game that exists but isn't theirs — a 403 confirms
  // the id is real, which is all an enumerator needs.
  if (!game) {
    return NextResponse.json({ success: false, message: "Game not found" }, { status: 404 });
  }

  const isPlayer = game.whiteUserId === payload.userId || game.blackUserId === payload.userId;
  if (!isPlayer) {
    // Entitled to see it only if entitled to see one of the players. Checked
    // sequentially rather than in parallel so a coach of the white player costs
    // one query, not two.
    const allowed =
      (game.whiteUserId ? await canViewStudent(payload, game.whiteUserId) : false) ||
      (game.blackUserId ? await canViewStudent(payload, game.blackUserId) : false);
    if (!allowed) {
      return NextResponse.json({ success: false, message: "Game not found" }, { status: 404 });
    }
    await writeAuditLog({
      action: "game.view",
      userId: payload.userId,
      metadata: {
        gameId,
        whiteUserId: game.whiteUserId,
        blackUserId: game.blackUserId,
        viewerRole: payload.role,
      },
      request,
    });
  }

  return NextResponse.json({ success: true, game, isPlayer });
}
