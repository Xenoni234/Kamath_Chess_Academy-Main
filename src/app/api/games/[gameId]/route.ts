import { NextRequest, NextResponse } from "next/server";
import { verifyAccessToken } from "@/lib/auth";
import { db } from "@/lib/db";

export async function GET(request: NextRequest, context: { params: Promise<{ gameId: string }> }) {
  const token = request.cookies.get("kca_access_token")?.value;

  if (!token) {
    return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
  }

  try {
    verifyAccessToken(token);
    const { gameId } = await context.params;
    const game = await db.game.findUnique({
      where: { id: gameId },
      include: {
        whiteUser: { select: { id: true, username: true } },
        blackUser: { select: { id: true, username: true } },
        records: true,
      },
    });

    if (!game) {
      return NextResponse.json({ success: false, message: "Game not found" }, { status: 404 });
    }

    return NextResponse.json({ success: true, game });
  } catch {
    return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
  }
}
