import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { verifyAccessToken } from "@/lib/auth";

/** Lichess puzzle ratings sit inside this band; the index seek targets it. */
const MIN_RATING = 400;
const MAX_RATING = 3000;
/** Small bounded walk past the seek point so repeat calls do not always land on the same row. */
const SCATTER = 50;

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

  // Previously `puzzle.count()` (a full scan of ~500k rows) followed by
  // `findFirst({ skip })` (an OFFSET scan of up to 500k). Both are unbounded and
  // get slower as the table grows. `rating` is indexed, so instead we jump to a
  // random point in that index and take the next row — an index seek plus a
  // short bounded walk, regardless of table size.
  const target = MIN_RATING + Math.floor(Math.random() * (MAX_RATING - MIN_RATING));
  const jitter = Math.floor(Math.random() * SCATTER);

  const puzzle =
    (await db.puzzle.findFirst({
      where: { rating: { gte: target } },
      orderBy: { rating: "asc" },
      skip: jitter,
    })) ??
    // Landed past the highest rating in the table — walk back down instead.
    (await db.puzzle.findFirst({
      where: { rating: { lte: target } },
      orderBy: { rating: "desc" },
    }));

  if (puzzle) {
    return NextResponse.json({ success: true, puzzles: [puzzle] });
  }

  const response = await fetch("https://lichess.org/api/puzzle/next", {
    headers: { Accept: "application/json" },
  });

  if (!response.ok) {
    return NextResponse.json({ success: false, message: "Puzzle fetch failed" }, { status: 502 });
  }

  return NextResponse.json({ success: true, puzzles: [mapLichessPuzzle(await response.json())] });
}
