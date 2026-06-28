import { NextRequest, NextResponse } from "next/server";
import { GameResult } from "@prisma/client";
import { verifyAccessToken } from "@/lib/auth";
import { db } from "@/lib/db";

function resultForUser(result: GameResult, isWhite: boolean) {
  if (result === GameResult.DRAW) return "draw";
  if (result === GameResult.ABORT) return "aborted";
  return (result === GameResult.WHITE_WIN && isWhite) || (result === GameResult.BLACK_WIN && !isWhite)
    ? "win"
    : "loss";
}

export async function GET(request: NextRequest) {
  const token = request.cookies.get("kca_access_token")?.value;

  if (!token) {
    return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
  }

  try {
    const payload = verifyAccessToken(token);
    const games = await db.game.findMany({
      where: {
        OR: [{ whiteUserId: payload.userId }, { blackUserId: payload.userId }],
      },
      orderBy: { playedAt: "desc" },
      take: 20,
      include: {
        whiteUser: { select: { id: true, username: true } },
        blackUser: { select: { id: true, username: true } },
        records: {
          where: { userId: payload.userId },
          select: { ratingBefore: true, ratingAfter: true },
        },
      },
    });

    return NextResponse.json({
      success: true,
      games: games.map((game) => {
        const isWhite = game.whiteUserId === payload.userId;
        const opponent = isWhite ? game.blackUser : game.whiteUser;
        const record = game.records[0];

        return {
          id: game.id,
          playedAt: game.playedAt,
          timeFormat: game.timeFormat,
          timeControl: game.timeControl,
          openingName: null,
          result: resultForUser(game.result, isWhite),
          ratingChange:
            record?.ratingAfter != null && record.ratingBefore != null ? record.ratingAfter - record.ratingBefore : null,
          opponent: opponent ? { id: opponent.id, username: opponent.username } : null,
        };
      }),
    });
  } catch {
    return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
  }
}
