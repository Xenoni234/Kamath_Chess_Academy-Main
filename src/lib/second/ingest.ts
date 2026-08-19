/**
 * Track F1 — opponent game ingestion with time-decay weighting.
 *
 * Pulls a player's recent games from Lichess and/or Chess.com, keeps a compact
 * per-game record, and weights each game by recency so the profile reflects how
 * they play *now*. The compact form is cached in Redis (24 h) and hydrated into
 * full position trees on demand — caching expanded FEN trees would blow past
 * Upstash's value-size limits.
 *
 * A dossier may merge up to 5 accounts, because a player's evidence is usually
 * split across sites. `fetchOpponentGamesMulti` is the entry point for that;
 * `fetchOpponentGames` remains as a single-account wrapper.
 *
 * Reuses the position-tree builders in engine/analysis.ts. FIDE has no game
 * API, so profiling always needs a Lichess/Chess.com handle (see AGENTS.md).
 */
import { buildLineFromSan } from "@/lib/engine/analysis";
import { pristineFetch } from "@/lib/pristineFetch";
import { redis } from "@/lib/redis";
import { clocksFromPgn, pgnTag, pgnTimestampMs, sanFromPgn } from "@/lib/second/pgnImport";
import { fetchOtbGames } from "@/lib/second/otb";
import type {
  AccountIngestStatus,
  AccountRef,
  ArtifactAccount,
  IngestDiagnostics,
  OpponentSource,
  RawGame,
  RawIngest,
  SpeedBucket,
  Termination,
  TimeControl,
  WeightedGame,
} from "@/lib/second/types";

const HALF_LIFE_DAYS = 180;
const DEFAULT_MAX = 200;
const CACHE_TTL_S = 24 * 60 * 60;
const MAX_CACHE_BYTES = 900_000;

/**
 * Bumped from v1 when the record grew termination, time control and ratings.
 * Without the bump, every dossier for the next 24 h would hydrate v1 values,
 * every new field would arrive `undefined`, and think time would silently
 * become null everywhere — output that looks plausible while being blind.
 */
const CACHE_VERSION = "v2";

/** No request may hang: nothing here had a timeout, so a wedged connection
 *  previously blocked until the 30-minute job watchdog fired. */
const REQUEST_TIMEOUT_MS = 15_000;

/** Bound the Chess.com monthly walk. A dormant account with 120 archives and 30
 *  games would otherwise spend the whole ingest budget being least useful. */
const MAX_ARCHIVE_MONTHS = 24;

/** How deep the hydrated position tree goes. Matches trie.ts MAX_TRIE_PLY;
 *  weakness.ts already stops at ply 20. Two FENs per ply makes this the
 *  dominant memory cost at 1000 games, and nothing today reads past it. The
 *  full SAN stays in the cache, so a deeper stage re-hydrates without refetching. */
export const HYDRATE_MAX_PLY = 24;

/** Accounts are fetched in parallel; the monthly walk inside one stays serial,
 *  because Chess.com throttles parallel bursts against the same endpoint. */
const ACCOUNT_CONCURRENCY = 3;

export type IngestResult = {
  games: WeightedGame[];
  ratingSummary: { format: string; rating: number | null; handle?: string; source?: OpponentSource }[];
};

export type MergedIngestResult = IngestResult & {
  accounts: ArtifactAccount[];
  diagnostics: IngestDiagnostics;
  /** Newest game across every account — the point recency decays from. */
  recencyReferenceMs: number;
};

// ---------------------------------------------------------------------------
// Normalisation helpers
// ---------------------------------------------------------------------------

/** Chess.com calls it `daily`; Lichess calls it `correspondence`. Same thing. */
function normaliseSpeed(raw: string | undefined): SpeedBucket {
  switch (raw) {
    case "ultraBullet":
    case "bullet":
    case "blitz":
    case "rapid":
    case "classical":
    case "correspondence":
      return raw;
    case "daily":
      return "correspondence";
    default:
      return "unknown";
  }
}

const LICHESS_TERMINATION: Record<string, Termination> = {
  mate: "mate",
  resign: "resign",
  // `outoftime` is a flag fall; `timeout` is a player who stopped moving. The
  // names read as synonyms and mean opposite things.
  outoftime: "flagged",
  timeout: "abandoned",
  noStart: "abandoned",
  stalemate: "stalemate",
  draw: "draw-unspecified",
  aborted: "aborted",
  cheat: "rules-infraction",
};

const CHESSCOM_TERMINATION: Record<string, Termination> = {
  checkmated: "mate",
  resigned: "resign",
  timeout: "flagged",
  abandoned: "abandoned",
  agreed: "draw-agreed",
  repetition: "repetition",
  stalemate: "stalemate",
  insufficient: "insufficient",
  "50move": "fifty-move",
  timevsinsufficient: "flag-vs-insufficient",
};

/** Lookup that never leaks a falsy source value into the Termination union. */
function terminationFrom(map: Record<string, Termination>, raw: string | null | undefined): Termination {
  if (!raw) return "unknown";
  return map[raw] ?? "unknown";
}

/**
 * Parse a Chess.com `time_control`.
 *
 * Three forms, and the third is the trap: "1/259200" is a correspondence game
 * at three days per move. Reading it with a naive parseInt yields a ONE SECOND
 * base clock, which then poisons every clock derivation and every sanity
 * ceiling downstream.
 */
function parseChessComTimeControl(raw: string | undefined, speed: SpeedBucket): TimeControl {
  const base: TimeControl = {
    initialSec: null,
    incrementSec: null,
    perMoveSec: null,
    speed,
    raw: raw ?? null,
  };
  if (!raw) return base;

  const perMove = /^1\/(\d+)$/.exec(raw);
  if (perMove) {
    return { ...base, perMoveSec: Number(perMove[1]), speed: "correspondence" };
  }

  const withIncrement = /^(\d+)\+(\d+)$/.exec(raw);
  if (withIncrement) {
    return { ...base, initialSec: Number(withIncrement[1]), incrementSec: Number(withIncrement[2]) };
  }

  if (/^\d+$/.test(raw)) {
    // A bare number really does mean zero increment — this is the one place an
    // increment of 0 is stated rather than assumed.
    return { ...base, initialSec: Number(raw), incrementSec: 0 };
  }

  return base;
}

async function timedFetch(url: string, init: RequestInit, signal?: AbortSignal) {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  return pristineFetch(url, {
    ...init,
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
}

/** 404 and 429 are not "this account has no games" and must not look like it. */
function statusFor(httpStatus: number): AccountIngestStatus {
  if (httpStatus === 404) return "not-found";
  if (httpStatus === 429) return "rate-limited";
  return "error";
}

const empty = (status: AccountIngestStatus): RawIngest => ({
  games: [],
  ratingSummary: [],
  status,
});

/**
 * Recency weight in (0, 1]; halves every HALF_LIFE_DAYS.
 *
 * Decay is measured from the newest game in the pool, not from "now", so a
 * player who stopped playing months ago still profiles at full strength while
 * recency *within* their history is preserved. When several accounts are
 * merged the reference is shared across all of them — see hydrateGames.
 */
function decayWeight(playedAtMs: number, referenceMs: number): number {
  const ageDays = Math.max(0, (referenceMs - playedAtMs) / (1000 * 60 * 60 * 24));
  return 0.5 ** (ageDays / HALF_LIFE_DAYS);
}

/** Canonical timestamp: the END of the game. A game is evidence only once it
 *  has finished. Null when the source gave neither — such games are dropped
 *  rather than defaulted to now, which used to assign maximum confidence to
 *  minimum information. */
function playedAtMsOf(g: RawGame): number | null {
  return g.endedAtMs ?? g.startedAtMs ?? null;
}

type PooledGame = { account: AccountRef; game: RawGame; playedAtMs: number };

/**
 * Expand compact records into position trees and apply recency weights.
 *
 * `referenceMs` is a parameter rather than derived here: with several accounts
 * merged, only the caller knows the newest game across the whole pool, and
 * per-account references would let an account abandoned 18 months ago weigh the
 * same as one played yesterday.
 */
function hydrateGames(
  pool: PooledGame[],
  referenceMs: number,
): { games: WeightedGame[]; clocksDiscardedMisaligned: number } {
  const games: WeightedGame[] = [];
  let clocksDiscardedMisaligned = 0;

  for (const { account, game, playedAtMs } of pool) {
    const allPlies = game.san.split(/\s+/).filter(Boolean);
    const nodes = buildLineFromSan(allPlies.slice(0, HYDRATE_MAX_PLY));
    if (nodes.length === 0) continue;

    // A clock array that does not line up with the move list shifts EVERY think
    // time in the game by a constant ply offset, so a mismatch means the array
    // is unusable and gets dropped whole.
    //
    // One extra entry is the exception, and it is the common case rather than a
    // corruption: when a game ends without a move — resignation, a flag fall —
    // both sites record a final clock reading with no ply behind it. Measured on
    // a 30-game sample: 21 games +1 (all resign/flagged), 9 games exact (all
    // mate). Rejecting those was discarding 70% of all clock data. The extra is
    // at the END, so trimming it is safe; anything else is a real mismatch.
    let clocks = game.clocks;
    if (clocks && clocks.length === allPlies.length + 1) {
      clocks = clocks.slice(0, allPlies.length);
    } else if (clocks && clocks.length !== allPlies.length) {
      clocks = undefined;
      clocksDiscardedMisaligned += 1;
    }

    games.push({
      color: game.color,
      nodes,
      san: game.san,
      openingName: game.openingName,
      eco: game.eco,
      won: game.won,
      drawn: game.drawn,
      gameKey: `${account.source}:${game.gameId}`,
      gameId: game.gameId,
      account,
      termination: game.termination,
      terminationRaw: game.terminationRaw,
      timeControl: game.tc,
      rated: game.rated,
      playerRating: game.playerRating,
      opponentRating: game.opponentRating,
      opponentHandle: game.opponentHandle,
      playedAt: new Date(playedAtMs),
      startedAt: game.startedAtMs !== null ? new Date(game.startedAtMs) : null,
      endedAt: game.endedAtMs !== null ? new Date(game.endedAtMs) : null,
      weight: decayWeight(playedAtMs, referenceMs),
      clocks: clocks?.slice(0, HYDRATE_MAX_PLY),
    });
  }

  return { games, clocksDiscardedMisaligned };
}

// ---------------------------------------------------------------------------
// Lichess
// ---------------------------------------------------------------------------

type LichessGame = {
  id?: string;
  createdAt?: number;
  lastMoveAt?: number;
  variant?: string;
  speed?: string;
  status?: string;
  rated?: boolean;
  winner?: "white" | "black";
  opening?: { name?: string; eco?: string };
  moves?: string;
  clocks?: number[];
  clock?: { initial?: number; increment?: number; totalTime?: number };
  players?: {
    white?: { user?: { name?: string }; rating?: number };
    black?: { user?: { name?: string }; rating?: number };
  };
};

async function fetchLichessRaw(
  handle: string,
  max: number,
  signal?: AbortSignal,
): Promise<RawIngest> {
  const url = `https://lichess.org/api/games/user/${encodeURIComponent(
    handle,
  )}?max=${max}&opening=true&clocks=true&sort=dateDesc`;

  const token = process.env.LICHESS_API_TOKEN;
  const response = await timedFetch(
    url,
    {
      headers: {
        Accept: "application/x-ndjson",
        // Optional spread, mirroring explorer.ts — unauthenticated still works,
        // it just gets a lower rate limit.
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    },
    signal,
  );
  if (!response.ok) return empty(statusFor(response.status));

  const text = await response.text();
  const wanted = handle.toLowerCase();
  const games: RawGame[] = [];
  const ratingByFormat = new Map<string, number>();

  for (const line of text.split("\n").filter(Boolean)) {
    let entry: LichessGame;
    try {
      entry = JSON.parse(line) as LichessGame;
    } catch {
      continue;
    }
    if (entry.variant && entry.variant !== "standard") continue;

    const white = entry.players?.white?.user?.name?.toLowerCase();
    const black = entry.players?.black?.user?.name?.toLowerCase();
    const color: "w" | "b" | null = white === wanted ? "w" : black === wanted ? "b" : null;
    if (!color || !entry.moves || !entry.id) continue;

    const speed = normaliseSpeed(entry.speed);
    const me = color === "w" ? entry.players?.white : entry.players?.black;
    const them = color === "w" ? entry.players?.black : entry.players?.white;
    // Games are newest-first, so the first rating seen per format is the latest.
    if (me?.rating && !ratingByFormat.has(speed)) ratingByFormat.set(speed, me.rating);

    games.push({
      color,
      san: entry.moves,
      openingName: entry.opening?.name ?? "Unknown Opening",
      eco: entry.opening?.eco ?? null,
      won: entry.winner === (color === "w" ? "white" : "black"),
      drawn: !entry.winner,
      gameId: entry.id,
      termination: terminationFrom(LICHESS_TERMINATION, entry.status),
      terminationRaw: entry.status ?? null,
      tc: {
        // Absent `clock` means correspondence: initial/increment stay null
        // rather than becoming zero.
        initialSec: entry.clock?.initial ?? null,
        incrementSec: entry.clock?.increment ?? null,
        perMoveSec: null,
        speed,
        raw: entry.clock ? `${entry.clock.initial}+${entry.clock.increment}` : null,
      },
      rated: entry.rated ?? null,
      playerRating: me?.rating ?? null,
      opponentRating: them?.rating ?? null,
      opponentHandle: them?.user?.name ?? null,
      startedAtMs: entry.createdAt ?? null,
      endedAtMs: entry.lastMoveAt ?? null,
      clocks: entry.clocks,
    });
  }

  return {
    games,
    ratingSummary: [...ratingByFormat.entries()].map(([format, rating]) => ({ format, rating })),
    status: "ok",
  };
}

// ---------------------------------------------------------------------------
// Chess.com
// ---------------------------------------------------------------------------

type ChessComGame = {
  uuid?: string;
  url?: string;
  pgn?: string;
  end_time?: number;
  start_time?: number;
  time_class?: string;
  time_control?: string;
  rated?: boolean;
  rules?: string;
  white?: { username?: string; rating?: number; result?: string };
  black?: { username?: string; rating?: number; result?: string };
};

const DRAW_RESULTS = new Set([
  "agreed",
  "repetition",
  "stalemate",
  "insufficient",
  "50move",
  "timevsinsufficient",
]);

async function fetchChessComRaw(
  handle: string,
  max: number,
  signal?: AbortSignal,
): Promise<RawIngest> {
  const archivesRes = await timedFetch(
    `https://api.chess.com/pub/player/${encodeURIComponent(handle)}/games/archives`,
    { headers: { Accept: "application/json" } },
    signal,
  );
  if (!archivesRes.ok) return empty(statusFor(archivesRes.status));
  const { archives = [] } = (await archivesRes.json()) as { archives?: string[] };

  const wanted = handle.toLowerCase();
  const games: RawGame[] = [];
  const ratingByFormat = new Map<string, number>();
  let monthsWalked = 0;

  // Archives are oldest-first; walk newest-first until we have enough. This
  // loop stays SERIAL — Chess.com throttles parallel bursts to one endpoint.
  for (let i = archives.length - 1; i >= 0 && games.length < max; i -= 1) {
    if (monthsWalked >= MAX_ARCHIVE_MONTHS) break;
    monthsWalked += 1;

    const monthRes = await timedFetch(archives[i], { headers: { Accept: "application/json" } }, signal);
    if (!monthRes.ok) {
      // A 429 partway through is worth surfacing rather than silently
      // returning a short list that reads as "they only played 40 games".
      if (monthRes.status === 429) {
        return { games, ratingSummary: summarise(ratingByFormat), status: "rate-limited" };
      }
      continue;
    }
    const { games: monthGames = [] } = (await monthRes.json()) as { games?: ChessComGame[] };

    for (let j = monthGames.length - 1; j >= 0 && games.length < max; j -= 1) {
      const entry = monthGames[j];
      if ((entry.rules ?? "chess") !== "chess" || !entry.pgn) continue;

      const white = entry.white?.username?.toLowerCase();
      const black = entry.black?.username?.toLowerCase();
      const color: "w" | "b" | null = white === wanted ? "w" : black === wanted ? "b" : null;
      if (!color) continue;

      const san = sanFromPgn(entry.pgn);
      if (!san) continue;

      const player = color === "w" ? entry.white : entry.black;
      const other = color === "w" ? entry.black : entry.white;
      const result = player?.result ?? "";
      const speed = normaliseSpeed(entry.time_class);
      if (player?.rating && !ratingByFormat.has(speed)) ratingByFormat.set(speed, player.rating);

      // The winner's `result` is always the flat "win" and carries no reason —
      // the reason lives on the LOSER. Reading our own side here would report
      // "unknown" as the termination on every game they won, i.e. half the set.
      const reasonRaw = result === "win" ? (other?.result ?? null) : result || null;

      games.push({
        color,
        san,
        openingName: pgnTag(entry.pgn, "Opening") ?? "Unknown Opening",
        eco: pgnTag(entry.pgn, "ECO"),
        won: result === "win",
        drawn: DRAW_RESULTS.has(result),
        gameId: entry.uuid ?? entry.url ?? `${entry.end_time ?? 0}-${white}-${black}`,
        termination: terminationFrom(CHESSCOM_TERMINATION, reasonRaw),
        terminationRaw: reasonRaw,
        tc: parseChessComTimeControl(entry.time_control, speed),
        rated: entry.rated ?? null,
        playerRating: player?.rating ?? null,
        opponentRating: other?.rating ?? null,
        opponentHandle: other?.username ?? null,
        startedAtMs:
          entry.start_time !== undefined
            ? entry.start_time * 1000
            : pgnTimestampMs(entry.pgn, "UTCDate", "UTCTime"),
        endedAtMs:
          entry.end_time !== undefined
            ? entry.end_time * 1000
            : pgnTimestampMs(entry.pgn, "EndDate", "EndTime"),
        clocks: clocksFromPgn(entry.pgn),
      });
    }
  }

  return { games, ratingSummary: summarise(ratingByFormat), status: "ok" };
}

function summarise(map: Map<string, number>) {
  return [...map.entries()].map(([format, rating]) => ({ format, rating }));
}

// ---------------------------------------------------------------------------
// Public
// ---------------------------------------------------------------------------

/** Fetch one account, reading the 24 h Redis cache first. */
async function fetchAccountRaw(
  account: AccountRef,
  max: number,
  signal?: AbortSignal,
): Promise<RawIngest> {
  const cacheKey = `second:ingest:${CACHE_VERSION}:${account.source}:${account.handle.toLowerCase()}`;

  try {
    const cached = (await redis.get(cacheKey)) as RawIngest | null;
    if (cached && Array.isArray(cached.games)) return { ...cached, status: cached.status ?? "ok" };
  } catch {
    // Cache miss / unavailable — fall through to a fresh fetch.
  }

  let raw: RawIngest;
  try {
    switch (account.source) {
      case "LICHESS":
        raw = await fetchLichessRaw(account.handle, max, signal);
        break;
      case "CHESSCOM":
        raw = await fetchChessComRaw(account.handle, max, signal);
        break;
      default:
        // MANUAL (pasted) and BROADCAST (FIDE/OTB) games never come from an
        // online handle API — they enter through their own ingest paths. Reaching
        // here means a wiring bug routed a synthetic handle at a live site; fail
        // loudly rather than silently fetching Chess.com for "pasted-1".
        throw new Error(`fetchSingleAccount cannot fetch source ${account.source}`);
    }
  } catch (error) {
    console.error(`[second] ingest failed for ${account.source}:${account.handle}`, error);
    return empty("error");
  }

  // Only cache a clean result. Caching a rate-limited empty would pin "this
  // account has no games" in place for 24 hours.
  if (raw.status === "ok" && raw.games.length > 0) {
    try {
      const serialized = JSON.stringify(raw);
      if (serialized.length <= MAX_CACHE_BYTES) {
        await redis.set(cacheKey, raw, { ex: CACHE_TTL_S });
      }
    } catch {
      // Never let a cache write break ingestion.
    }
  }

  return raw;
}

/** Run `worker` over `items` with at most `limit` in flight, preserving order. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index]);
    }
  });
  await Promise.all(runners);
  return results;
}

/**
 * Fetch, merge and weight an opponent's games across 1..5 accounts.
 *
 * The order of operations below is the design, not an implementation detail:
 * dedup before the budget trim (or duplicates eat the budget), self-play before
 * anything (the same human sat on both sides, so neither perspective is
 * evidence), and the recency reference computed AFTER the trim, over the merged
 * pool, so one shared reference governs every account.
 */
export async function fetchOpponentGamesMulti(
  accounts: AccountRef[],
  options: {
    perAccountMax?: number;
    totalMax?: number;
    signal?: AbortSignal;
    fideId?: string;
    /** Pre-parsed pasted games, injected as a MANUAL account. */
    manualGames?: RawGame[];
    /** Display name for the manual/OTB sources. */
    manualName?: string;
  } = {},
): Promise<MergedIngestResult> {
  const perAccountMax = options.perAccountMax ?? DEFAULT_MAX;
  const manualCount = options.manualGames?.length ? 1 : 0;
  const sourceCount = accounts.length + (options.fideId ? 1 : 0) + manualCount;
  const totalMax = options.totalMax ?? perAccountMax * Math.max(1, sourceCount);

  const fetched = await mapWithConcurrency(accounts, ACCOUNT_CONCURRENCY, (account) =>
    fetchAccountRaw(account, perAccountMax, options.signal).then((raw) => ({ account, raw })),
  );

  // OTB games via a FIDE id enter as one more account, source BROADCAST, with a
  // synthetic handle (the FIDE id) and the real name in displayName. From here
  // on they are pooled, deduped and weighted exactly like an online account.
  let otbNote: string | null = null;
  if (options.fideId) {
    const otb = await fetchOtbGames(options.fideId, { signal: options.signal });
    otbNote = otb.note;
    fetched.push({
      account: { handle: options.fideId, source: "BROADCAST", displayName: otb.playerName },
      raw: { games: otb.games, ratingSummary: otb.ratingSummary, status: "ok" },
    });
  }

  // Pasted games enter as one MANUAL account, synthetic handle "pasted".
  if (options.manualGames?.length) {
    fetched.push({
      account: { handle: "pasted", source: "MANUAL", displayName: options.manualName ?? null },
      raw: { games: options.manualGames, ratingSummary: [], status: "ok" },
    });
  }

  const diagnostics: IngestDiagnostics = {
    totalFetched: 0,
    duplicatesDropped: 0,
    selfPlayDropped: 0,
    noTimestampDropped: 0,
    budgetTrimmed: 0,
    clocksDiscardedMisaligned: 0,
  };

  // Pass 1 — index by dedup key, and note which accounts contributed each game.
  const byKey = new Map<string, { entries: PooledGame[]; accounts: Set<string> }>();
  for (const { account, raw } of fetched) {
    diagnostics.totalFetched += raw.games.length;
    for (const game of raw.games) {
      const playedAtMs = playedAtMsOf(game);
      if (playedAtMs === null) {
        diagnostics.noTimestampDropped += 1;
        continue;
      }
      const key = `${account.source}:${game.gameId}`;
      const slot = byKey.get(key) ?? { entries: [], accounts: new Set<string>() };
      slot.entries.push({ account, game, playedAtMs });
      slot.accounts.add(`${account.source}:${account.handle.toLowerCase()}`);
      byKey.set(key, slot);
    }
  }

  // Pass 2 — resolve each key to at most one game.
  const pool: PooledGame[] = [];
  for (const slot of byKey.values()) {
    if (slot.accounts.size > 1) {
      // Two profiled accounts played each other. Keeping either side would
      // attribute a game the opponent played against themselves to their
      // repertoire, from both ends.
      diagnostics.selfPlayDropped += slot.entries.length;
      continue;
    }
    diagnostics.duplicatesDropped += slot.entries.length - 1;
    pool.push(slot.entries[0]);
  }

  // Newest first, then trim. Deliberately NOT an even split across accounts: an
  // account with 200 games and one with 12 should contribute 200 and 12.
  //
  // OTB games are exempt from the trim. They are scarce (a handful per player)
  // and old relative to online blitz, so a pure recency sort would push them
  // below the budget cutoff and silently drop the games that matter MOST for
  // over-the-board preparation. Trim only the online games down to the budget.
  pool.sort((a, b) => b.playedAtMs - a.playedAtMs);
  const protectedSources = new Set(["BROADCAST", "MANUAL"]);
  const otbPool = pool.filter((g) => protectedSources.has(g.account.source));
  const onlinePool = pool.filter((g) => !protectedSources.has(g.account.source));
  const onlineBudget = Math.max(0, totalMax - otbPool.length);
  if (onlinePool.length > onlineBudget) {
    diagnostics.budgetTrimmed = onlinePool.length - onlineBudget;
    onlinePool.length = onlineBudget;
  }
  pool.length = 0;
  pool.push(...otbPool, ...onlinePool);
  pool.sort((a, b) => b.playedAtMs - a.playedAtMs);

  const recencyReferenceMs = pool.reduce((max, g) => Math.max(max, g.playedAtMs), 0) || Date.now();
  const { games, clocksDiscardedMisaligned } = hydrateGames(pool, recencyReferenceMs);
  diagnostics.clocksDiscardedMisaligned = clocksDiscardedMisaligned;
  diagnostics.otbNote = otbNote;

  // Per-account provenance. `meanWeight` is the number that makes the shared
  // reference auditable — an account at 0.1 is three half-lives stale, and the
  // user can see that rather than having it hidden inside the maths.
  const artifactAccounts: ArtifactAccount[] = fetched.map(({ account, raw }) => {
    const mine = games.filter(
      (g) =>
        g.account.source === account.source &&
        g.account.handle.toLowerCase() === account.handle.toLowerCase(),
    );
    const times = mine.map((g) => g.playedAt.getTime());
    return {
      handle: account.handle,
      source: account.source,
      displayName: account.displayName ?? null,
      gamesFetched: raw.games.length,
      gamesUsed: mine.length,
      oldestPlayedAt: times.length ? new Date(Math.min(...times)).toISOString() : null,
      newestPlayedAt: times.length ? new Date(Math.max(...times)).toISOString() : null,
      meanWeight: mine.length
        ? Math.round((mine.reduce((sum, g) => sum + g.weight, 0) / mine.length) * 1000) / 1000
        : 0,
      status: raw.status,
    };
  });

  // Keyed by account AND format: two accounts both playing blitz used to
  // collide on "blitz" and silently lose one of the ratings.
  const ratingSummary = fetched.flatMap(({ account, raw }) =>
    raw.ratingSummary.map((entry) => ({
      ...entry,
      handle: account.handle,
      source: account.source,
    })),
  );

  return {
    games,
    ratingSummary,
    accounts: artifactAccounts,
    diagnostics,
    recencyReferenceMs,
  };
}

/**
 * Single-account wrapper, kept so existing callers compile unchanged.
 */
export async function fetchOpponentGames(
  handle: string,
  source: OpponentSource,
  options: { max?: number; signal?: AbortSignal } = {},
): Promise<IngestResult> {
  const merged = await fetchOpponentGamesMulti([{ handle, source }], {
    perAccountMax: options.max ?? DEFAULT_MAX,
    totalMax: options.max ?? DEFAULT_MAX,
    signal: options.signal,
  });
  return { games: merged.games, ratingSummary: merged.ratingSummary };
}
