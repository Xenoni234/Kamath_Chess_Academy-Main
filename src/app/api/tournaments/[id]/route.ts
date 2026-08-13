import { NextRequest, NextResponse } from "next/server";
import { verifyAccessToken } from "@/lib/auth";
import { db } from "@/lib/db";

export const runtime = "nodejs";

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const token = request.cookies.get("kca_access_token")?.value;
  if (!token) {
    return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
  }
  try {
    const payload = verifyAccessToken(token);
    const { id } = await context.params;
    const tournament = await db.tournament.findUnique({
      where: { id },
      include: {
        players: {
          orderBy: [{ score: "desc" }, { joinedAt: "asc" }],
          include: { user: { select: { id: true, username: true } } },
        },
      },
    });
    if (!tournament) {
      return NextResponse.json({ success: false, message: "Not found" }, { status: 404 });
    }

    return NextResponse.json({
      success: true,
      tournament: {
        id: tournament.id,
        title: tournament.title,
        description: tournament.description,
        type: tournament.type,
        status: tournament.status,
        startsAt: tournament.startsAt,
        joined: tournament.players.some((p) => p.userId === payload.userId),
        standings: tournament.players.map((p, i) => ({
          rank: p.rank ?? i + 1,
          userId: p.user.id,
          username: p.user.username,
          score: p.score,
        })),
      },
    });
  } catch {
    return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
  }
}
