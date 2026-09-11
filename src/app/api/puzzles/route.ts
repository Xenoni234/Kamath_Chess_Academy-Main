import { NextRequest, NextResponse } from "next/server";
import { verifyAccessToken } from "@/lib/auth";
import { db } from "@/lib/db";
import { puzzleQuerySchema } from "@/lib/validations/phase2";

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

  let payload: ReturnType<typeof verifyAccessToken>;
  try {
    payload = verifyAccessToken(token);
  } catch {
    return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
  }

  // A failure below here is a server fault, not an auth failure. Returning 401
  // for it used to log every user out on a single database blip, silently.
  try {
    const parsedQuery = puzzleQuerySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
    if (!parsedQuery.success) {
      return NextResponse.json({ success: false, message: "Invalid puzzle filters" }, { status: 400 });
    }
    const { theme, minRating, maxRating, limit } = parsedQuery.data;
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

    // No reviews due — serve a fresh puzzle. Prefer ones the user has never
    // attempted, picked at random so "next puzzle" doesn't repeat.
    //
    // This used to load *every* puzzleId the user had ever attempted into memory
    // and send them back as `id: { notIn: [...] }` against a ~500k-row table,
    // then `count()` + a random OFFSET on top. All three are unbounded. Now the
    // exclusion is a NOT EXISTS via the relation filter, and the random pick is
    // an index seek on `rating` followed by a short forward walk.
    const themeFilter = theme ? { has: theme } : undefined;

    const pickRandom = async (excludeAttempted: boolean) => {
      const target = minRating + Math.floor(Math.random() * Math.max(1, maxRating - minRating));
      const base = {
        themes: themeFilter,
        ...(excludeAttempted ? { attempts: { none: { userId: payload.userId } } } : {}),
      };

      const forward = await db.puzzle.findMany({
        where: { ...base, rating: { gte: target, lte: maxRating } },
        take: limit,
        orderBy: { rating: "asc" },
      });
      if (forward.length > 0) return forward;

      // Seek landed in a sparse part of the band — walk back down instead.
      const backward = await db.puzzle.findMany({
        where: { ...base, rating: { gte: minRating, lte: target } },
        take: limit,
        orderBy: { rating: "desc" },
      });
      return backward.length > 0 ? backward : null;
    };

    const puzzles = (await pickRandom(true)) ?? (await pickRandom(false));

    if (puzzles && puzzles.length > 0) {
      return NextResponse.json({ success: true, puzzles });
    }

    const response = await fetch("https://lichess.org/api/puzzle/next", {
      headers: { Accept: "application/json" },
    });

    if (!response.ok) {
      return NextResponse.json({ success: false, message: "Puzzle fetch failed" }, { status: 502 });
    }

    return NextResponse.json({ success: true, puzzles: [mapLichessPuzzle(await response.json())] });
  } catch (error) {
    console.error("[puzzles] GET failed:", error);
    return NextResponse.json({ success: false, message: "Something went wrong." }, { status: 500 });
  }
}
