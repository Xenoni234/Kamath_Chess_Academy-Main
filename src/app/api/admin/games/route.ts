import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { verifyAccessToken } from "@/lib/auth";
import { requireRole } from "@/lib/authz";
import { db } from "@/lib/db";
import { writeAuditLog } from "@/lib/audit";

export const runtime = "nodejs";

/**
 * Every game on the platform, newest first — what the Head dashboard's "Games Played"
 * number is actually counting.
 *
 * HEAD and HR only. `/api/games` is deliberately self-scoped (you see your own games),
 * and widening it with a flag would have made one route mean two different things
 * depending on a parameter. A separate route with its own role check is harder to get
 * wrong.
 *
 * Reading it is audited: these are games belonging to identifiable students, so staff
 * browsing them is access to personal data and the DPDPA log should show it.
 */
const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
});

export async function GET(request: NextRequest) {
  const token = request.cookies.get("kca_access_token")?.value;
  if (!token) return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });

  let payload: ReturnType<typeof verifyAccessToken>;
  try {
    payload = verifyAccessToken(token);
  } catch {
    return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
  }

  // `requireRole` returns a DENIAL RESPONSE or null — it is not a boolean. Writing
  // `if (!requireRole(...))` inverts it: authorised staff get refused and everyone else
  // walks through. Follow the shape every other admin route here uses.
  const denied = requireRole(payload, ["HEAD", "HR"]);
  if (denied) return denied;

  const parsed = querySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!parsed.success) {
    return NextResponse.json({ success: false, message: "Invalid filters" }, { status: 400 });
  }
  const { limit, cursor } = parsed.data;

  try {
    const games = await db.game.findMany({
      // `id` as the tiebreak: `createdAt` is not unique, and a bare cursor on a
      // non-unique column silently skips rows at page boundaries.
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: {
        id: true,
        createdAt: true,
        result: true,
        termination: true,
        timeControl: true,
        timeFormat: true,
        rated: true,
        moves: true,
        whiteUser: { select: { username: true } },
        blackUser: { select: { username: true } },
      },
    });

    const hasMore = games.length > limit;
    const page = hasMore ? games.slice(0, limit) : games;

    await writeAuditLog({
      action: "admin.games.read",
      userId: payload.userId,
      metadata: { count: page.length },
      request,
    });

    return NextResponse.json({
      success: true,
      games: page.map((g) => ({
        id: g.id,
        createdAt: g.createdAt,
        // A deleted account leaves a null relation; the game still happened.
        white: g.whiteUser?.username ?? "(deleted)",
        black: g.blackUser?.username ?? "(deleted)",
        result: g.result,
        termination: g.termination,
        timeControl: g.timeControl,
        format: g.timeFormat,
        rated: g.rated,
        moveCount: g.moves.length,
      })),
      nextCursor: hasMore ? page[page.length - 1]?.id : null,
    });
  } catch (error) {
    console.error("[admin/games] GET failed:", error);
    return NextResponse.json({ success: false, message: "Something went wrong." }, { status: 500 });
  }
}
