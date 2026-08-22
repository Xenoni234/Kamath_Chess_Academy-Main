/**
 * Opening-name resolution for the Opening Trainer (Phase 5).
 *
 * The bundled dataset (scripts/importOpenings.ts) is the ONLY place a typed name
 * like "Caro-Kann Defence" becomes concrete moves — nothing else in the repo maps
 * name -> moves. Resolution is deliberately forgiving: British/American spelling,
 * punctuation, and word order should not matter, and an unrecognised trap name
 * returns the closest candidates rather than nothing.
 *
 * The data direction everywhere else is position -> name (Explorer, PGN tags);
 * this module is the one reverse index.
 */
import openingsData from "./data/openings.json";
import { START_FEN } from "@/lib/engine/analysis";
import type { OpeningEntry, ResolvedOpening } from "./types";

const ENTRIES = openingsData as OpeningEntry[];

/** Lowercase, fold British spelling, strip punctuation, collapse whitespace. */
export function normalize(input: string): string {
  return input
    .toLowerCase()
    .replace(/defence/g, "defense")
    .replace(/centre/g, "center")
    .replace(/gambit's/g, "gambits")
    .replace(/[''`]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function familyOf(name: string): string {
  const idx = name.indexOf(":");
  return idx === -1 ? name : name.slice(0, idx);
}

/**
 * Generation-algorithm tag baked into the cache slug. Bump it to invalidate every
 * cached repertoire globally when the pipeline changes in a way that alters output.
 */
export const OPENING_ALGO = "v1";

/** Stable cache key for a repertoire: canonical name + colour + algo version. */
export function openingSlug(canonicalName: string, color: string): string {
  return `${normalize(canonicalName)}:${color}:${OPENING_ALGO}`;
}

/** Precomputed search index — built once at module load. */
type Indexed = {
  entry: OpeningEntry;
  normName: string;
  normFamily: string;
  tokens: Set<string>;
};

const INDEX: Indexed[] = ENTRIES.map((entry) => {
  const family = familyOf(entry.name);
  const normName = normalize(entry.name);
  return {
    entry,
    normName,
    normFamily: normalize(family),
    tokens: new Set(normName.split(" ").filter(Boolean)),
  };
});

function toResolved(entry: OpeningEntry): ResolvedOpening {
  return {
    eco: entry.eco,
    name: entry.name,
    family: familyOf(entry.name),
    san: entry.san,
    uci: entry.uci,
    fen: entry.fen,
    ply: entry.ply,
  };
}

/** Levenshtein distance, capped for short strings (family names are short). */
function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let curr = new Array<number>(n + 1);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

/**
 * Score how well `q` matches an indexed entry. Higher is better; 0 = no match.
 * Shallower plies win ties so a family query lands on the family root (the short
 * defining line), which is what `variationsOf` needs as a prefix.
 */
function score(q: string, qTokens: string[], item: Indexed): number {
  const shallow = Math.max(0, 40 - item.entry.ply); // tie-breaker, <= priority gaps
  if (item.normName === q) return 10000 + shallow;
  if (item.normFamily === q) return 9000 + shallow;
  if (item.normName.startsWith(q)) return 7000 + shallow;
  if (item.normFamily.startsWith(q)) return 6500 + shallow;
  if (item.normName.includes(q)) return 5000 + shallow;

  // Token coverage: every query token present somewhere in the name.
  const covered = qTokens.filter((t) => item.tokens.has(t)).length;
  if (qTokens.length > 0 && covered === qTokens.length) return 4000 + shallow;
  if (covered > 0) return 2000 + covered * 100 + shallow;

  // Fuzzy fallback on the family, for typos ("caro cann").
  const dist = editDistance(q, item.normFamily);
  const ratio = 1 - dist / Math.max(q.length, item.normFamily.length);
  if (ratio >= 0.7) return 1000 + Math.round(ratio * 500);
  return 0;
}

/**
 * Ranked matches for a query, de-duplicated by opening name (best line kept).
 * Used by the autocomplete/disambiguation route.
 */
export function searchOpenings(query: string, limit = 8): ResolvedOpening[] {
  const q = normalize(query);
  if (!q) return [];
  const qTokens = q.split(" ").filter(Boolean);

  const scored: { item: Indexed; s: number }[] = [];
  for (const item of INDEX) {
    const s = score(q, qTokens, item);
    if (s > 0) scored.push({ item, s });
  }
  scored.sort((a, b) => b.s - a.s);

  const seen = new Set<string>();
  const out: ResolvedOpening[] = [];
  for (const { item } of scored) {
    if (seen.has(item.entry.name)) continue;
    seen.add(item.entry.name);
    out.push(toResolved(item.entry));
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Resolve a name to its single canonical opening line — the family root when the
 * query names a family, else the best specific match. Returns null only when
 * nothing scores at all (a completely unknown string).
 */
export function resolveOpening(query: string): ResolvedOpening | null {
  return searchOpenings(query, 1)[0] ?? null;
}

/** Exact lookup by full UCI move-order — the stable key a job re-resolves with. */
export function resolveByUci(uci: string[]): ResolvedOpening | null {
  const key = uci.join(" ");
  for (const entry of ENTRIES) {
    if (entry.uci.join(" ") === key) return toResolved(entry);
  }
  return null;
}

/**
 * Every named variation whose move-order has `rootUci` as a strict prefix — the
 * opening's sub-variations (Advance, Panov, Exchange, …), with real names. This
 * is what makes the repertoire diverse: the dataset already enumerates them.
 */
export function variationsOf(rootUci: string[]): ResolvedOpening[] {
  if (rootUci.length === 0) return [];
  const out: ResolvedOpening[] = [];
  for (const entry of ENTRIES) {
    if (entry.uci.length <= rootUci.length) continue;
    let isPrefix = true;
    for (let i = 0; i < rootUci.length; i++) {
      if (entry.uci[i] !== rootUci[i]) {
        isPrefix = false;
        break;
      }
    }
    if (isPrefix) out.push(toResolved(entry));
  }
  return out;
}

/** The start position, re-exported so callers need not import from engine. */
export { START_FEN };
