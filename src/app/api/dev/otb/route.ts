/**
 * Dev-only diagnostic for the OTB (FIDE → Lichess broadcast) fetch chain.
 *
 * The chain lives in src/lib/second/otb.ts and can only run where there is real
 * outbound network — which the Bash sandbox does not have, but the dev server
 * does. This route runs each stage of the chain inside the server process and
 * returns everything as JSON, so the chain can be exercised and debugged by
 * curling localhost:
 *
 *   curl -s "http://localhost:3000/api/dev/otb?fideId=46608524" | jq .
 *
 * 404 outside development. No auth by design (local diagnostic only), matching
 * the unauthenticated /api/health route and the NODE_ENV idiom in
 * auth/register/route.ts and db.ts.
 */
import { NextRequest, NextResponse } from "next/server";
import {
  discoverBroadcasts,
  fetchBroadcastPgn,
  fetchFidePlayer,
  fetchOtbGames,
  searchBroadcastTours,
  slugToQuery,
} from "@/lib/second/otb";
import { splitPgnGames } from "@/lib/second/pgnImport";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  if (process.env.NODE_ENV !== "development") {
    return NextResponse.json({ error: "dev only" }, { status: 404 });
  }

  const fideId = request.nextUrl.searchParams.get("fideId")?.trim();
  if (!fideId) {
    return NextResponse.json({ error: "pass ?fideId=<digits>" }, { status: 400 });
  }
  const max = Number(request.nextUrl.searchParams.get("max") ?? 20) || 20;
  const dump = request.nextUrl.searchParams.get("dump")?.trim();

  // Targeted single-tour inspection: fetch one tour's PGN and report whether it
  // carries FIDE tags / the target id, plus the first game's raw header. Cheap
  // (one fetch) vs the full chain (many).
  if (dump) {
    try {
      const pgn = await fetchBroadcastPgn(dump);
      if (!pgn) return NextResponse.json({ dump, ok: false, note: "no PGN (404 or fetch failed)" });
      const games = splitPgnGames(pgn);
      const first = games[0] ?? "";
      const firstTags = (first.match(/^\[[^\]]*\]/gm) ?? []).slice(0, 24);
      return NextResponse.json({
        dump,
        bytes: pgn.length,
        gameCount: games.length,
        hasWhiteFideId: /\[WhiteFideId\s/.test(pgn),
        hasBlackFideId: /\[BlackFideId\s/.test(pgn),
        containsTargetId: fideId ? pgn.includes(fideId) : null,
        firstGameTags: firstTags,
      });
    } catch (error) {
      return NextResponse.json({ dump, error: (error as Error).message }, { status: 500 });
    }
  }

  // Clean read of the real product path only — skips the per-stage diagnostics
  // that would burn the rate limit before fetchOtbGames (paced) even runs.
  if (request.nextUrl.searchParams.get("only") === "otb") {
    try {
      const otb = await fetchOtbGames(fideId, { max });
      return NextResponse.json({
        fideId,
        playerName: otb.playerName,
        note: otb.note,
        gameCount: otb.games.length,
        sample: otb.games.slice(0, 15).map((g) => ({
          color: g.color,
          opponent: g.opponentHandle,
          playerRating: g.playerRating,
          opponentRating: g.opponentRating,
          incrementSec: g.tc.incrementSec,
          incrementInferred: g.tc.incrementInferred,
          result: g.won ? "won" : g.drawn ? "drew" : "lost",
          date: g.endedAtMs ? new Date(g.endedAtMs).toISOString().slice(0, 10) : null,
        })),
      });
    } catch (error) {
      return NextResponse.json({ error: (error as Error).message }, { status: 500 });
    }
  }

  try {
    // 1. FIDE profile.
    const player = await fetchFidePlayer(fideId);

    // 2. Discovery (the fragile scrape).
    const discovery = await discoverBroadcasts(fideId);

    // 3. Resolve each scraped slug to canonical tour ids via search.
    const searchBySlug: Record<string, { id: string; name: string }[]> = {};
    const candidateTourIds = new Set<string>(discovery.ids);
    for (const slug of discovery.slugs) {
      const tours = await searchBroadcastTours(slugToQuery(slug));
      searchBySlug[slug] = tours;
      for (const t of tours) candidateTourIds.add(t.id);
    }

    // 4. Fetch each candidate tournament PGN and count its games.
    const pgnByTour: { id: string; ok: boolean; bytes: number; gameCount: number }[] = [];
    for (const id of candidateTourIds) {
      const pgn = await fetchBroadcastPgn(id);
      pgnByTour.push({
        id,
        ok: pgn !== null,
        bytes: pgn?.length ?? 0,
        gameCount: pgn ? splitPgnGames(pgn).length : 0,
      });
    }

    // 5. The real product path, end to end.
    const otb = await fetchOtbGames(fideId, { max });
    const sample = otb.games.slice(0, 10).map((g) => ({
      color: g.color,
      opponent: g.opponentHandle,
      playerRating: g.playerRating,
      opponentRating: g.opponentRating,
      incrementSec: g.tc.incrementSec,
      incrementInferred: g.tc.incrementInferred,
      result: g.won ? "won" : g.drawn ? "drew" : "lost",
      date: g.endedAtMs ? new Date(g.endedAtMs).toISOString().slice(0, 10) : null,
    }));

    return NextResponse.json({
      fideId,
      player,
      discovery,
      searchBySlug,
      candidateTourIds: [...candidateTourIds],
      pgnByTour,
      otb: {
        playerName: otb.playerName,
        note: otb.note,
        gameCount: otb.games.length,
        sample,
      },
    });
  } catch (error) {
    // Surface the throw — the otb.ts helpers swallow failures, but a bug in this
    // route or an unexpected shape should be visible, not hidden.
    return NextResponse.json(
      { error: (error as Error).message, stack: (error as Error).stack?.split("\n").slice(0, 5) },
      { status: 500 },
    );
  }
}
