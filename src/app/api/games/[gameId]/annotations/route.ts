/**
 * Coach notes on individual moves of a game.
 *
 * Who can do what:
 *  - **Read**: anyone entitled to see the game (the players, a parent, the coach,
 *    staff). A student is meant to read their coach's notes — that is the point.
 *  - **Write**: COACH, HR or HEAD only, and only on a game belonging to a student
 *    they are entitled to see. A student cannot annotate their own game here;
 *    that would be a different feature with different semantics.
 *
 * Notes are keyed `(gameId, coachId, ply)`, so re-saving the same move updates in
 * place rather than stacking duplicates, while two coaches can each annotate the
 * same move without colliding.
 *
 * `ply` is 1-based and matches `PositionNode.ply` from `src/lib/engine/analysis.ts`
 * — ply 1 is the position AFTER White's first move.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { verifyAccessToken } from "@/lib/auth";
import { canViewStudent, hasRole } from "@/lib/authz";
import { db } from "@/lib/db";

export const runtime = "nodejs";

const upsertSchema = z.object({
  ply: z.number().int().min(0).max(600),
  /** Empty body deletes the note — the natural result of clearing the textarea. */
  body: z.string().trim().max(2000),
});

const deleteSchema = z.object({ ply: z.number().int().min(0).max(600) });

/** Resolve the game and whether this caller may read / write notes on it. */
async function access(gameId: string, payload: { userId: string; role: string }) {
  const game = await db.game.findUnique({
    where: { id: gameId },
    select: { id: true, whiteUserId: true, blackUserId: true },
  });
  if (!game) return { game: null as null, canRead: false, canWrite: false };

  const isPlayer = game.whiteUserId === payload.userId || game.blackUserId === payload.userId;
  const canRead =
    isPlayer ||
    (game.whiteUserId ? await canViewStudent(payload as never, game.whiteUserId) : false) ||
    (game.blackUserId ? await canViewStudent(payload as never, game.blackUserId) : false);

  // Writing needs a teaching role AND the relationship — a coach cannot annotate
  // a stranger's game just by being a coach.
  const canWrite = canRead && hasRole(payload.role as never, ["COACH", "HR", "HEAD"]);
  return { game, canRead, canWrite };
}

function auth(request: NextRequest) {
  const token = request.cookies.get("kca_access_token")?.value;
  if (!token) return null;
  try {
    return verifyAccessToken(token);
  } catch {
    return null;
  }
}

export async function GET(request: NextRequest, context: { params: Promise<{ gameId: string }> }) {
  const payload = auth(request);
  if (!payload) return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });

  try {
    const { gameId } = await context.params;
    const { game, canRead, canWrite } = await access(gameId, payload);
    if (!game || !canRead) {
      return NextResponse.json({ success: false, message: "Not found" }, { status: 404 });
    }

    const annotations = await db.gameAnnotation.findMany({
      where: { gameId },
      orderBy: { ply: "asc" },
      select: {
        id: true,
        ply: true,
        body: true,
        coachId: true,
        updatedAt: true,
        coach: { select: { username: true } },
      },
    });

    return NextResponse.json({
      success: true,
      canAnnotate: canWrite,
      annotations: annotations.map((a) => ({
        id: a.id,
        ply: a.ply,
        body: a.body,
        coachId: a.coachId,
        coachName: a.coach.username,
        updatedAt: a.updatedAt,
        mine: a.coachId === payload.userId,
      })),
    });
  } catch (error) {
    console.error("[games/[gameId]/annotations] GET failed:", error);
    return NextResponse.json({ success: false, message: "Something went wrong." }, { status: 500 });
  }
}

export async function PUT(request: NextRequest, context: { params: Promise<{ gameId: string }> }) {
  const payload = auth(request);
  if (!payload) return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });

  try {
    const { gameId } = await context.params;
    const { game, canRead, canWrite } = await access(gameId, payload);
    if (!game || !canRead) {
      return NextResponse.json({ success: false, message: "Not found" }, { status: 404 });
    }
    if (!canWrite) {
      return NextResponse.json(
        { success: false, message: "Only a coach can annotate this game." },
        { status: 403 },
      );
    }

    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      return NextResponse.json({ success: false, message: "Invalid request body" }, { status: 400 });
    }

    const parsed = upsertSchema.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, message: "Validation failed.", errors: parsed.error.flatten().fieldErrors },
        { status: 400 },
      );
    }
    const { ply, body } = parsed.data;

    // Clearing the text removes the note rather than storing an empty one, so the
    // move-list marker disappears with it.
    if (body.length === 0) {
      await db.gameAnnotation.deleteMany({ where: { gameId, coachId: payload.userId, ply } });
      return NextResponse.json({ success: true, deleted: true });
    }

    const saved = await db.gameAnnotation.upsert({
      where: { gameId_coachId_ply: { gameId, coachId: payload.userId, ply } },
      create: { gameId, coachId: payload.userId, ply, body },
      update: { body },
      select: { id: true, ply: true, body: true, updatedAt: true },
    });

    return NextResponse.json({ success: true, annotation: saved });
  } catch (error) {
    console.error("[games/[gameId]/annotations] PUT failed:", error);
    return NextResponse.json({ success: false, message: "Something went wrong." }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest, context: { params: Promise<{ gameId: string }> }) {
  const payload = auth(request);
  if (!payload) return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });

  try {
    const { gameId } = await context.params;
    const { game, canRead, canWrite } = await access(gameId, payload);
    if (!game || !canRead) {
      return NextResponse.json({ success: false, message: "Not found" }, { status: 404 });
    }
    if (!canWrite) {
      return NextResponse.json({ success: false, message: "Not permitted" }, { status: 403 });
    }

    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      return NextResponse.json({ success: false, message: "Invalid request body" }, { status: 400 });
    }

    const parsed = deleteSchema.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json({ success: false, message: "Validation failed." }, { status: 400 });
    }

    // Scoped to this coach's own note — one coach must not delete another's.
    const result = await db.gameAnnotation.deleteMany({
      where: { gameId, coachId: payload.userId, ply: parsed.data.ply },
    });
    return NextResponse.json({ success: true, deleted: result.count });
  } catch (error) {
    console.error("[games/[gameId]/annotations] DELETE failed:", error);
    return NextResponse.json({ success: false, message: "Something went wrong." }, { status: 500 });
  }
}
