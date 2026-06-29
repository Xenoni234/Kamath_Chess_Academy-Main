import { NextRequest, NextResponse } from "next/server";
import { verifyAccessToken } from "@/lib/auth";
import { db } from "@/lib/db";

type LichessPuzzleResponse = {
  game?: { id?: string; pgn?: string };
  puzzle?: { id?: string; fen?: string; initialPly?: number; solution?: string[]; rating?: number; themes?: string[] };
};

function mapLichessPuzzle(data: LichessPuzzleResponse) {
  const puzzle = data.puzzle;

  return {
    id: puzzle?.id ?? data.game?.id ?? "lichess-next",
    fen: puzzle?.fen ?? "",
    moves: puzzle?.solution?.join(" ") ?? "",
    rating: puzzle?.rating ?? null,
    themes: puzzle?.themes ?? [],
    source: "lichess",
  };
}

export async function GET(request: NextRequest) {
  const token = request.cookies.get("kca_access_token")?.value;

  if (!token) {
    return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
  }

  try {
    const payload = verifyAccessToken(token);
    const theme = request.nextUrl.searchParams.get("theme");
    const minRating = Number(request.nextUrl.searchParams.get("minRating") ?? 800);
    const maxRating = Number(request.nextUrl.searchParams.get("maxRating") ?? 2000);
    const limit = Math.min(Number(request.nextUrl.searchParams.get("limit") ?? 1), 25);
    const now = new Date();
    const dueAttempts = await db.puzzleAttempt.findMany({
      where: { userId: payload.userId, nextReviewAt: { lte: now }, puzzle: theme ? { themes: { has: theme } } : undefined },
      take: limit,
      orderBy: { nextReviewAt: "asc" },
      include: { puzzle: true },
    });

    if (dueAttempts.length > 0) {
      return NextResponse.json({ success: true, puzzles: dueAttempts.map((attempt) => attempt.puzzle) });
    }

    const puzzles = await db.puzzle.findMany({
      where: {
        rating: { gte: minRating, lte: maxRating },
        themes: theme ? { has: theme } : undefined,
      },
      take: limit,
      orderBy: { createdAt: "desc" },
    });

    if (puzzles.length > 0) {
      return NextResponse.json({ success: true, puzzles });
    }

    const response = await fetch("https://lichess.org/api/puzzle/next", {
      headers: { Accept: "application/json" },
    });

    if (!response.ok) {
      return NextResponse.json({ success: false, message: "Puzzle fetch failed" }, { status: 502 });
    }

    return NextResponse.json({ success: true, puzzles: [mapLichessPuzzle(await response.json())] });
  } catch {
    return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
  }
}
