import { NextRequest, NextResponse } from "next/server";
import { verifyAccessToken } from "@/lib/auth";
import { db } from "@/lib/db";

export const runtime = "nodejs";

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const token = request.cookies.get("kca_access_token")?.value;
  if (!token) {
    return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
  }
  try {
    const payload = verifyAccessToken(token);
    const { id } = await context.params;

    const tournament = await db.tournament.findUnique({ where: { id }, select: { status: true } });
    if (!tournament) {
      return NextResponse.json({ success: false, message: "Not found" }, { status: 404 });
    }
    if (tournament.status !== "UPCOMING") {
      return NextResponse.json({ success: false, message: "Registration is closed." }, { status: 400 });
    }

    const existing = await db.tournamentPlayer.findFirst({ where: { tournamentId: id, userId: payload.userId } });
    if (!existing) {
      await db.tournamentPlayer.create({ data: { tournamentId: id, userId: payload.userId } });
    }
    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
  }
}
