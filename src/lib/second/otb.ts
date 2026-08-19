/**
 * Track F3 — over-the-board game ingestion from a FIDE ID.
 *
 * The opponent's OTB classical games are the ones that matter most for national
 * preparation, and they never appear on Lichess/Chess.com. This module reaches
 * them through Lichess's broadcast relays, which carry real tournament PGN with
 * two things online play cannot give us: an exact `[WhiteFideId]`/`[BlackFideId]`
 * for identity, and a per-game `[WhiteElo]`/`[BlackElo]`.
 *
 * The chain, every step verified against the live API during exploration:
 *
 *   FIDE ID
 *     -> GET /api/fide/player/{id}          official — name, federation, ratings
 *     -> GET /fide/{id}/redirect  (HTML)    discover broadcast links  [scraping]
 *     -> GET /api/broadcast/search?q=...     official — resolve slug to tour.id
 *     -> GET /api/broadcast/{tourId}.pgn     official — every round, one file
 *     -> filter by [WhiteFideId]/[BlackFideId]   exact, no name guessing
 *
 * The one fragile step is the redirect scrape. It DEGRADES rather than fails:
 * when it finds no links, we fall back to the broadcast search by the player's
 * name and surface the reason, so an OTB miss never sinks the whole dossier.
 *
 * OTB PGN has no `[TimeControl]` tag, which would void every think-time figure
 * (an unknown increment propagates as null think time by design). We infer the
 * increment from the clock series instead — see `inferOtbTimeControl`.
 */
import { pristineFetch } from "@/lib/pristineFetch";
import { parsePgnGame, splitPgnGames } from "@/lib/second/pgnImport";
import type { RawGame, RawIngest, TimeControl } from "@/lib/second/types";

const REQUEST_TIMEOUT_MS = 15_000;

/** Non-zero increments that actually occur in OTB play: 10s (rapid) and 30s
 *  (FIDE classical). We snap UP to the smallest of these that the clock rises
 *  are consistent with. */
const STANDARD_INCREMENTS_SEC = [10, 30];

/** Below this a "rise" is truncation noise, not an increment. Clock stamps are
 *  whole seconds (H:MM:SS), so sub-second rounding can fake a 1-2s gain. */
const MIN_RISE_SEC = 3;

/**
 * Infer a TimeControl for an OTB game from its clock series.
 *
 * Clocks are REMAINING time per ply. In an increment game a player who moves
 * faster than the increment ends the move with MORE time than they started it —
 * the clock rises. Across a whole game at least one move is usually near-instant,
 * so `max(rise)` approaches the true increment from below. It is a hard lower
 * bound: you cannot gain 30s on a move without a >=30s increment. So we snap up
 * to the smallest standard increment the rises are consistent with.
 *
 * When the clocks only ever fall we infer 0, NOT because the game had no
 * increment but because the evidence cannot show one — a game where both
 * players always spent more than the increment looks identical to a no-increment
 * game. That is the honest reading, and `incrementInferred` flags it as derived.
 *
 * Base clock is genuinely unknowable from remaining-time alone (increment lets
 * remaining exceed the base), so `initialSec` is set to the largest reading —
 * an over-estimate, which only loosens the think-time sanity ceiling rather than
 * wrongly rejecting real think times.
 */
export function inferOtbTimeControl(clocks: (number | null)[] | undefined): TimeControl {
  const base: TimeControl = {
    initialSec: null,
    incrementSec: null,
    perMoveSec: null,
    speed: "unknown",
    raw: null,
    incrementInferred: true,
  };
  if (!clocks || clocks.length < 4) return base;

  // Largest single per-player rise (consecutive readings for one side are two
  // plies apart), skipping the null holes that preserve ply alignment.
  let maxRiseSec = 0;
  for (let i = 2; i < clocks.length; i += 1) {
    const earlier = clocks[i - 2];
    const later = clocks[i];
    if (earlier == null || later == null) continue;
    const riseSec = (later - earlier) / 100;
    if (riseSec > maxRiseSec) maxRiseSec = riseSec;
  }

  let incrementSec = 0;
  if (maxRiseSec >= MIN_RISE_SEC) {
    incrementSec =
      STANDARD_INCREMENTS_SEC.find((candidate) => candidate >= maxRiseSec) ??
      STANDARD_INCREMENTS_SEC[STANDARD_INCREMENTS_SEC.length - 1];
  }

  const maxClockCs = clocks.reduce<number>((max, c) => (c != null && c > max ? c : max), 0);
  const initialSec = maxClockCs > 0 ? Math.round(maxClockCs / 100) : null;

  // Lichess-style estimated duration to bucket the speed. Increment counts for
  // ~40 moves. OTB broadcasts are classical or rapid in practice.
  const estimatedSec = (initialSec ?? 0) + incrementSec * 40;
  const speed = estimatedSec >= 1500 ? "classical" : estimatedSec >= 480 ? "rapid" : "blitz";

  return { ...base, initialSec, incrementSec, speed };
}

// ---------------------------------------------------------------------------
// Live fetch chain
// ---------------------------------------------------------------------------

export type FidePlayer = {
  id: string;
  name: string;
  federation: string | null;
  standard: number | null;
  rapid: number | null;
  blitz: number | null;
};

async function timedFetch(url: string, signal?: AbortSignal): Promise<Response> {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  return pristineFetch(url, {
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    headers: { Accept: "application/json, text/html" },
  });
}

/** Official FIDE profile. Null on any failure — a missing profile is not fatal,
 *  it just means we cannot label the OTB source with a real name. */
export async function fetchFidePlayer(fideId: string, signal?: AbortSignal): Promise<FidePlayer | null> {
  try {
    const res = await timedFetch(`https://lichess.org/api/fide/player/${encodeURIComponent(fideId)}`, signal);
    if (!res.ok) return null;
    const data = (await res.json()) as {
      name?: string;
      federation?: string;
      standard?: number;
      rapid?: number;
      blitz?: number;
    };
    if (!data.name) return null;
    return {
      id: fideId,
      name: data.name,
      federation: data.federation ?? null,
      standard: typeof data.standard === "number" ? data.standard : null,
      rapid: typeof data.rapid === "number" ? data.rapid : null,
      blitz: typeof data.blitz === "number" ? data.blitz : null,
    };
  } catch {
    return null;
  }
}

/** Nav links that appear on the redirect page alongside real events. */
const BROADCAST_NAV_NOISE = new Set(["app", "calendar", "help", "subscribed", "new"]);

export type BroadcastDiscovery = {
  /** 8-char base62 ids lifted straight from broadcast hrefs (tour or round). */
  ids: string[];
  /** Name slugs for the search fallback, e.g. "mumbai-open-2024". */
  slugs: string[];
};

/** Lichess tour and round ids are 8 base62 chars. */
const BROADCAST_ID = /^[A-Za-z0-9]{8}$/;

/**
 * Scrape the FIDE redirect page for broadcast references. THE fragile step: it
 * reads Lichess's HTML and will break when their markup changes. Returns empty
 * arrays rather than throwing so the caller can fall back to search.
 *
 * A broadcast href is `/broadcast/{name-slug}/{round-slug}/{roundId}` (or the
 * shorter tour form), so we harvest BOTH: any 8-char id (used directly against
 * the PGN endpoint) and the leading name slug (resolved to a canonical tour id
 * via search). Feeding both into the candidate set means the ingest still works
 * if either half of the URL shape shifts.
 */
export async function discoverBroadcasts(fideId: string, signal?: AbortSignal): Promise<BroadcastDiscovery> {
  try {
    const res = await timedFetch(`https://lichess.org/fide/${encodeURIComponent(fideId)}/redirect`, signal);
    if (!res.ok) return { ids: [], slugs: [] };
    const html = await res.text();
    const ids = new Set<string>();
    const slugs = new Set<string>();
    for (const match of html.matchAll(/href="\/broadcast\/([^"]+)"/g)) {
      const segments = match[1].split("/").filter(Boolean);
      const head = segments[0];
      if (head && !BROADCAST_NAV_NOISE.has(head) && !BROADCAST_ID.test(head)) slugs.add(head);
      // Nav words like "calendar" are 8 chars and pass BROADCAST_ID, so filter
      // them here too, not just at the slug head.
      for (const seg of segments) if (BROADCAST_ID.test(seg) && !BROADCAST_NAV_NOISE.has(seg)) ids.add(seg);
    }
    return { ids: [...ids], slugs: [...slugs] };
  } catch {
    return { ids: [], slugs: [] };
  }
}

type BroadcastTour = { id: string; name: string };

/** Resolve a set of search terms to broadcast tournament ids via the official
 *  search API. Used both to turn a scraped slug into a tour id and, on fallback,
 *  to find tournaments by the player's name. */
export async function searchBroadcastTours(query: string, signal?: AbortSignal): Promise<BroadcastTour[]> {
  try {
    const res = await timedFetch(
      `https://lichess.org/api/broadcast/search?q=${encodeURIComponent(query)}`,
      signal,
    );
    if (!res.ok) return [];
    const data = (await res.json()) as { currentPageResults?: { tour?: { id?: string; name?: string } }[] };
    const out: BroadcastTour[] = [];
    for (const entry of data.currentPageResults ?? []) {
      const id = entry.tour?.id;
      if (id) out.push({ id, name: entry.tour?.name ?? id });
    }
    return out;
  } catch {
    return [];
  }
}

/** Every round of one broadcast tournament, concatenated PGN. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * One tournament's PGN, with one retry on a 429.
 *
 * Broadcast PGN files are large (~400KB) and the endpoint is rate limited, so a
 * burst of tour fetches trips a 429 and — without this — `fetchBroadcastPgn`
 * would silently return null and drop that tournament's games entirely, which
 * showed up as the SAME tour succeeding in one run and failing in the next.
 * Respect the Retry-After header (capped) and try once more.
 */
export async function fetchBroadcastPgn(tourId: string, signal?: AbortSignal): Promise<string | null> {
  const url = `https://lichess.org/api/broadcast/${encodeURIComponent(tourId)}.pgn`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const res = await timedFetch(url, signal);
      if (res.status === 429 && attempt === 0) {
        const retryAfter = Number(res.headers.get("retry-after"));
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 10_000) : 3_000);
        continue;
      }
      if (!res.ok) return null;
      return await res.text();
    } catch {
      return null;
    }
  }
  return null;
}

export type OtbIngest = RawIngest & {
  /** The resolved FIDE name, for the account's displayName. */
  playerName: string | null;
  /** How discovery went, surfaced so the dossier can say what it could not see. */
  note: string | null;
};

/** Cap on tournaments pulled per player. A prolific player may appear in dozens
 *  of relays; the newest handful carry the current-form games we want. */
const MAX_TOURS = 6;
/** Cap on OTB games kept per player, matched to the online per-account budget. */
const MAX_OTB_GAMES = 60;

/**
 * Ingest a player's OTB games by FIDE ID.
 *
 * Never throws: any step can degrade to empty with a stated `note`, because an
 * OTB miss must not sink a dossier that still has online games.
 */
export async function fetchOtbGames(
  fideId: string,
  opts: { max?: number; signal?: AbortSignal } = {},
): Promise<OtbIngest> {
  const max = opts.max ?? MAX_OTB_GAMES;
  const signal = opts.signal;

  const player = await fetchFidePlayer(fideId, signal);
  const playerName = player?.name ?? null;

  // Discover tournaments: scrape the redirect page, then resolve to canonical
  // tour ids via search. Scraped ids and search ids both feed one candidate set;
  // a wrong candidate just 404s at the PGN endpoint and is skipped.
  const discovery = await discoverBroadcasts(fideId, signal);
  // Search-resolved TOUR ids first: those are the canonical ids that work
  // against /api/broadcast/{id}.pgn. The scraped ids are usually ROUND ids that
  // 404 on that endpoint, so they trail as a fallback rather than consuming the
  // MAX_TOURS budget ahead of the real tournaments (measured: they crowded out
  // every working tour and produced zero games).
  const searchIds: string[] = [];
  for (const slug of discovery.slugs) {
    for (const tour of await searchBroadcastTours(slugToQuery(slug), signal)) searchIds.push(tour.id);
  }
  const candidateIds = new Set<string>([...searchIds, ...discovery.ids]);

  let note: string | null = null;
  if (candidateIds.size === 0) {
    // Fragile step found nothing — fall back to a name search, and say so.
    if (playerName) {
      for (const tour of await searchBroadcastTours(playerName, signal)) candidateIds.add(tour.id);
      note =
        candidateIds.size > 0
          ? "broadcast links were not found on the FIDE page; used a name search instead"
          : "no broadcasts found for this FIDE ID — OTB games are unavailable";
    } else {
      note = "FIDE profile could not be read — OTB games are unavailable";
    }
  }
  const tourIds = [...candidateIds];

  const ratingSummary: RawIngest["ratingSummary"] = player
    ? [
        { format: "OTB standard", rating: player.standard, handle: player.name, source: "BROADCAST" },
        { format: "OTB rapid", rating: player.rapid, handle: player.name, source: "BROADCAST" },
      ].filter((r) => r.rating !== null)
    : [];

  if (tourIds.length === 0) {
    return { games: [], ratingSummary, status: "ok", playerName, note };
  }

  const games: RawGame[] = [];
  const seenIds = new Set<string>();
  let fetchedTours = 0;
  for (const tourId of tourIds.slice(0, MAX_TOURS)) {
    if (games.length >= max) break;
    // Space out the large PGN fetches to stay under the broadcast rate limit.
    if (fetchedTours > 0) await sleep(700);
    fetchedTours += 1;
    const pgn = await fetchBroadcastPgn(tourId, signal);
    if (!pgn) continue;
    for (const one of splitPgnGames(pgn)) {
      if (games.length >= max) break;
      // Only games this player actually played. parsePgnGame returns an error
      // (not a game) when the FIDE id is in neither colour's tag.
      const parsed = parsePgnGame(one, { playerFideId: fideId });
      if ("error" in parsed) continue;
      if (seenIds.has(parsed.game.gameId)) continue;
      seenIds.add(parsed.game.gameId);
      // OTB PGN has no [TimeControl]; infer it from the clocks.
      const withTc: RawGame = { ...parsed.game, tc: inferOtbTimeControl(parsed.game.clocks) };
      games.push(withTc);
    }
  }

  if (games.length === 0 && note === null) {
    note = "found broadcasts, but none contained a game for this FIDE ID";
  }

  return { games, ratingSummary, status: "ok", playerName, note };
}

/** Strip a scraped slug ("mumbai-open-2024") down to searchable words. */
export function slugToQuery(slug: string): string {
  return slug.replace(/[-_]+/g, " ").trim();
}
