import { NextResponse } from "next/server";
import { db } from "@/lib/db";

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

export async function GET() {
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
