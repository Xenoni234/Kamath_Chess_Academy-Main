import { NextRequest, NextResponse } from "next/server";
import { verifyAccessToken } from "@/lib/auth";
import { requireRole } from "@/lib/authz";
import { db } from "@/lib/db";
import { createTournamentSchema } from "@/lib/validations/phase3";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const token = request.cookies.get("kca_access_token")?.value;
  if (!token) {
    return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
  }
  try {
    verifyAccessToken(token);
    // Only these fields are read below, and the listing needs an upper bound —
    // it previously fetched whole rows for every tournament ever held.
    const tournaments = await db.tournament.findMany({
      orderBy: { startsAt: "desc" },
      take: 100,
      select: {
        id: true,
        title: true,
        type: true,
        status: true,
        startsAt: true,
        _count: { select: { players: true } },
      },
    });
    return NextResponse.json({
      success: true,
      tournaments: tournaments.map((t) => ({
        id: t.id,
        title: t.title,
        type: t.type,
        status: t.status,
        startsAt: t.startsAt,
        playerCount: t._count.players,
      })),
    });
  } catch {
    return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
  }
}

export async function POST(request: NextRequest) {
  const token = request.cookies.get("kca_access_token")?.value;
  if (!token) {
    return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
  }
  try {
    const payload = verifyAccessToken(token);
    const denied = requireRole(payload, ["HR", "HEAD"]);
    if (denied) return denied;

    const parsed = createTournamentSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, message: "Validation failed.", errors: parsed.error.flatten().fieldErrors },
        { status: 400 },
      );
    }
    const { title, description, type, startsAt } = parsed.data;
    const tournament = await db.tournament.create({
      data: { title, description, type, startsAt: new Date(startsAt), status: "UPCOMING" },
    });
    return NextResponse.json({ success: true, tournament });
  } catch {
    return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
  }
}
