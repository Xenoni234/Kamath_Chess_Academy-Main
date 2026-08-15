/**
 * Track F1 — opponent game ingestion with time-decay weighting.
 *
 * Pulls a player's recent games from Lichess or Chess.com, keeps a compact
 * per-game record (SAN move list, result, timestamp, clocks), and weights each
 * game by recency so the profile reflects how they play *now*. The compact form
 * is cached in Redis (24 h) and hydrated into full position trees on demand —
 * caching expanded FEN trees would blow past Upstash's value-size limits.
 *
 * Reuses the position-tree builders in engine/analysis.ts. FIDE has no game
 * API, so profiling always needs a Lichess/Chess.com handle (see AGENTS.md).
 */
import { buildLineFromSan } from "@/lib/engine/analysis";
import { pristineFetch } from "@/lib/pristineFetch";
import { redis } from "@/lib/redis";
import type { OpponentSource, WeightedGame } from "@/lib/second/types";

const HALF_LIFE_DAYS = 180;
const DEFAULT_MAX = 200;
const CACHE_TTL_S = 24 * 60 * 60;
const MAX_CACHE_BYTES = 900_000;

/** Compact, cacheable game record — no expanded FEN tree, no recency weight. */
type RawGame = {
  color: "w" | "b";
  san: string;
  openingName: string;
  won: boolean;
  drawn: boolean;
  playedAtMs: number;
  clocks?: number[];
  timeControl: string;
};

type RawIngest = {
  games: RawGame[];
  ratingSummary: { format: string; rating: number | null }[];
};

export type IngestResult = {
  games: WeightedGame[];
  ratingSummary: { format: string; rating: number | null }[];
};

/**
 * Recency weight in (0, 1]; halves every HALF_LIFE_DAYS. Decay is measured from
 * the player's most recent game, not from "now", so a player who stopped
 * playing months ago still profiles at full strength while recency *within*
 * their own history is preserved.
 */
function decayWeight(playedAtMs: number, referenceMs: number): number {
  const ageDays = Math.max(0, (referenceMs - playedAtMs) / (1000 * 60 * 60 * 24));
  return 0.5 ** (ageDays / HALF_LIFE_DAYS);
}

function hydrate(raw: RawIngest): IngestResult {
  const reference = raw.games.reduce((max, g) => Math.max(max, g.playedAtMs), 0) || Date.now();
  const games: WeightedGame[] = [];
  for (const g of raw.games) {
    const nodes = buildLineFromSan(g.san.split(/\s+/).filter(Boolean));
    if (nodes.length === 0) continue;
    games.push({
      color: g.color,
      nodes,
      openingName: g.openingName,
      won: g.won,
      drawn: g.drawn,
      playedAt: new Date(g.playedAtMs),
      weight: decayWeight(g.playedAtMs, reference),
      clocks: g.clocks,
      timeControl: g.timeControl,
    });
  }
  return { games, ratingSummary: raw.ratingSummary };
}

// ---------------------------------------------------------------------------
// Lichess
// ---------------------------------------------------------------------------

type LichessGame = {
  createdAt?: number;
  variant?: string;
  speed?: string;
  winner?: "white" | "black";
  opening?: { name?: string };
  moves?: string;
  clocks?: number[];
  players?: {
    white?: { user?: { name?: string }; rating?: number };
    black?: { user?: { name?: string }; rating?: number };
  };
};

async function fetchLichessRaw(handle: string, max: number): Promise<RawIngest> {
  const url = `https://lichess.org/api/games/user/${encodeURIComponent(
    handle,
  )}?max=${max}&opening=true&clocks=true&sort=dateDesc`;
  const response = await pristineFetch(url, { headers: { Accept: "application/x-ndjson" } });
  if (!response.ok) return { games: [], ratingSummary: [] };

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
    if (!color || !entry.moves) continue;

    const speed = entry.speed ?? "unknown";
    const rating = color === "w" ? entry.players?.white?.rating : entry.players?.black?.rating;
    // Games are newest-first, so the first rating seen per format is the latest.
    if (rating && !ratingByFormat.has(speed)) ratingByFormat.set(speed, rating);

    games.push({
      color,
      san: entry.moves,
      openingName: entry.opening?.name ?? "Unknown Opening",
      won: entry.winner === (color === "w" ? "white" : "black"),
      drawn: !entry.winner,
      playedAtMs: entry.createdAt ?? Date.now(),
      clocks: entry.clocks,
      timeControl: speed,
    });
  }

  return {
    games,
    ratingSummary: [...ratingByFormat.entries()].map(([format, rating]) => ({ format, rating })),
  };
}

// ---------------------------------------------------------------------------
// Chess.com
// ---------------------------------------------------------------------------

type ChessComGame = {
  pgn?: string;
  end_time?: number;
  time_class?: string;
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

/** Pull remaining-clock centiseconds per ply from a PGN's %clk comments. */
function clocksFromPgn(pgn: string): number[] {
  const out: number[] = [];
  const re = /\[%clk\s+(\d+):(\d+):(\d+(?:\.\d+)?)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(pgn)) !== null) {
    const cs = Math.round((Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) * 100);
    out.push(cs);
  }
  return out;
}

/** Strip a PGN to a bare SAN move list ("e4 e5 Nf3 ..."). */
function sanFromPgn(pgn: string): string {
  const body = pgn.replace(/\[[^\]]*\]/g, " ").replace(/\{[^}]*\}/g, " ");
  return body
    .replace(/\d+\.(\.\.)?/g, " ")
    .replace(/\$\d+/g, " ")
    .replace(/(1-0|0-1|1\/2-1\/2|\*)/g, " ")
    .replace(/[?!]+/g, "")
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");
}

async function fetchChessComRaw(handle: string, max: number): Promise<RawIngest> {
  const archivesRes = await pristineFetch(
    `https://api.chess.com/pub/player/${encodeURIComponent(handle)}/games/archives`,
    { headers: { Accept: "application/json" } },
  );
  if (!archivesRes.ok) return { games: [], ratingSummary: [] };
  const { archives = [] } = (await archivesRes.json()) as { archives?: string[] };

  const wanted = handle.toLowerCase();
  const games: RawGame[] = [];
  const ratingByFormat = new Map<string, number>();

  // archives are oldest-first; walk newest-first until we have enough.
  for (let i = archives.length - 1; i >= 0 && games.length < max; i -= 1) {
    const monthRes = await pristineFetch(archives[i], { headers: { Accept: "application/json" } });
    if (!monthRes.ok) continue;
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
      const result = player?.result ?? "";
      const format = entry.time_class ?? "unknown";
      if (player?.rating && !ratingByFormat.has(format)) ratingByFormat.set(format, player.rating);

      games.push({
        color,
        san,
        openingName: entry.pgn.match(/\[Opening "([^"]+)"\]/)?.[1] ?? "Unknown Opening",
        won: result === "win",
        drawn: DRAW_RESULTS.has(result),
        playedAtMs: (entry.end_time ?? Math.floor(Date.now() / 1000)) * 1000,
        clocks: clocksFromPgn(entry.pgn),
        timeControl: format,
      });
    }
  }

  return {
    games,
    ratingSummary: [...ratingByFormat.entries()].map(([format, rating]) => ({ format, rating })),
  };
}

// ---------------------------------------------------------------------------
// Public
// ---------------------------------------------------------------------------

/**
 * Fetch and weight an opponent's games. Reads a 24 h Redis cache first; the
 * recency weights are always recomputed at read time so a cached profile stays
 * current. Cache writes are best-effort and skipped when the payload is large.
 */
export async function fetchOpponentGames(
  handle: string,
  source: OpponentSource,
  options: { max?: number } = {},
): Promise<IngestResult> {
  const max = options.max ?? DEFAULT_MAX;
  const cacheKey = `second:ingest:${source}:${handle.toLowerCase()}`;

  try {
    const cached = (await redis.get(cacheKey)) as RawIngest | null;
    if (cached && Array.isArray(cached.games)) return hydrate(cached);
  } catch {
    // Cache miss / unavailable — fall through to a fresh fetch.
  }

  const raw =
    source === "LICHESS" ? await fetchLichessRaw(handle, max) : await fetchChessComRaw(handle, max);

  try {
    const serialized = JSON.stringify(raw);
    if (serialized.length <= MAX_CACHE_BYTES) {
      await redis.set(cacheKey, raw, { ex: CACHE_TTL_S });
    }
  } catch {
    // Never let a cache write break ingestion.
  }

  return hydrate(raw);
}
