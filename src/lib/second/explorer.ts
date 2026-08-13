import crypto from "node:crypto";
import { db } from "@/lib/db";

/**
 * Shared access to the Lichess Opening Explorer, with a 24 h read-through cache
 * in the OpeningCache table. Extracted from `api/analysis/opening/route.ts` so
 * both the openings page route and the novelty miner (Phase 4) read the explorer
 * identically. Behaviour is unchanged for the route.
 *
 * The explorer moved to explorer.lichess.org and now requires an OAuth token —
 * any Lichess personal access token works (no scopes). Without LICHESS_API_TOKEN
 * the upstream returns 401 and callers should degrade gracefully.
 */
const EXPLORER_BASE = "https://explorer.lichess.org/lichess";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export const DEFAULT_SPEEDS = ["blitz", "rapid", "classical"];
export const DEFAULT_RATINGS = ["1600", "1800", "2000", "2200", "2500"];

/** One candidate move at a position, with its human game split. */
export type ExplorerMove = {
  uci: string;
  san: string;
  white: number;
  draws: number;
  black: number;
  averageRating?: number;
};

export type ExplorerData = {
  white: number;
  draws: number;
  black: number;
  moves: ExplorerMove[];
  opening?: { eco: string; name: string } | null;
};

export type ExplorerResult =
  | { ok: true; data: ExplorerData; cached: boolean }
  | { ok: false; status: number };

/**
 * Fetch explorer stats for a FEN. Returns a discriminated result so route
 * callers can map upstream failures to HTTP status codes, and library callers
 * (novelty mining) can simply check `ok`.
 */
export async function fetchExplorer(
  fen: string,
  speeds: string[] = DEFAULT_SPEEDS,
  ratings: string[] = DEFAULT_RATINGS,
): Promise<ExplorerResult> {
  const fenHash = crypto
    .createHash("md5")
    .update(`${fen}|${speeds.join(",")}|${ratings.join(",")}`)
    .digest("hex");

  const cached = await db.openingCache.findUnique({ where: { fenHash } });
  if (cached && cached.expiresAt > new Date()) {
    return { ok: true, data: cached.data as unknown as ExplorerData, cached: true };
  }

  const url = `${EXPLORER_BASE}?fen=${encodeURIComponent(
    fen,
  )}&speeds=${speeds.join(",")}&ratings=${ratings.join(",")}&topGames=0&recentGames=0`;

  const lichessToken = process.env.LICHESS_API_TOKEN;
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      ...(lichessToken ? { Authorization: `Bearer ${lichessToken}` } : {}),
    },
  });

  if (!response.ok) {
    return { ok: false, status: response.status };
  }

  const data = (await response.json()) as ExplorerData;
  const expiresAt = new Date(Date.now() + CACHE_TTL_MS);

  await db.openingCache.upsert({
    where: { fenHash },
    create: { fenHash, data: data as unknown as object, expiresAt },
    update: { data: data as unknown as object, expiresAt },
  });

  return { ok: true, data, cached: false };
}
