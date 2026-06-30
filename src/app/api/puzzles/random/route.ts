import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { verifyAccessToken } from "@/lib/auth";

type LichessPuzzleResponse = {
  game?: { id?: string };
  puzzle?: { id?: string; fen?: string; solution?: string[]; rating?: number; themes?: string[] };
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
    verifyAccessToken(token);
  } catch {
    return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
  }

  const count = await db.puzzle.count();

  if (count > 0) {
    const skip = Math.floor(Math.random() * count);
    const puzzle = await db.puzzle.findFirst({ skip });

    return NextResponse.json({ success: true, puzzles: puzzle ? [puzzle] : [] });
  }

  const response = await fetch("https://lichess.org/api/puzzle/next", {
    headers: { Accept: "application/json" },
  });

  if (!response.ok) {
    return NextResponse.json({ success: false, message: "Puzzle fetch failed" }, { status: 502 });
  }

  return NextResponse.json({ success: true, puzzles: [mapLichessPuzzle(await response.json())] });
}
