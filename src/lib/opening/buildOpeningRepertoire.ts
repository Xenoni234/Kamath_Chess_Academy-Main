/**
 * Seed the repertoire for an opening: choose a diverse set of named variations and
 * turn each into a `RepertoireLine` the engine later extends to 30 plies.
 *
 * Diversity is the point. The dataset already enumerates every named sub-variation
 * (Advance, Panov, Exchange, Classical, …); we bucket them by their FIRST move away
 * from the opening, keep the most canonical (shallowest) representative of each
 * branch, and rank branches by real Explorer popularity. That guarantees the
 * repertoire spans the genuinely different lines rather than five flavours of one.
 *
 * `buildOpeningSeeds` is pure (dataset + the pre-built book); the engine best-line
 * pick happens in the job after extension via `pickBestLine`.
 */
import { variationsOf } from "./eco";
import type { OpeningColor, OpeningTag, OpeningVariation, RepertoireLine, ResolvedOpening } from "./types";
import type { TrieNode } from "@/lib/second/types";

/** Default cap on variations (plus the mainline) in one repertoire. */
export const MAX_VARIATIONS = 12;

/** Walk the book along a SAN path; return the node's popularity, or null. */
function popularityOf(book: TrieNode, san: string[]): number | null {
  let node: TrieNode = book;
  for (const s of san) {
    const next = node.children[s];
    if (!next) return null;
    node = next;
  }
  return node.weightedCount > 0 ? node.weightedCount : null;
}

function tagForName(name: string): OpeningTag {
  const lower = name.toLowerCase();
  if (lower.includes("trap")) return "trap";
  if (lower.includes("gambit")) return "gambit";
  return "variation";
}

/** Short, factual rationale for a seed line (before the AI guide annotates it). */
function rationaleFor(v: ResolvedOpening, popularity: number | null): string {
  const branch = v.san.slice(-1)[0] ?? "";
  const pop = popularity !== null ? `${popularity.toLocaleString()} human games in the Explorer` : "an offbeat try";
  return `${v.name}${branch ? ` (…${branch})` : ""} — ${pop}.`;
}

/** True when `a` is a (non-strict) prefix of `b`. */
function isPrefix(a: string[], b: string[]): boolean {
  if (a.length > b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Pick the major named variations of the opening, most popular first.
 *
 * The real branch points of an opening are usually deeper than its first move
 * (every major Caro-Kann line begins 1.e4 c6 2.d4), so bucketing by first move is
 * too coarse. Instead we rank the *specifically named* variations by how often the
 * wider population reaches them (Explorer weight), then greedily pick, skipping any
 * line that is a parent or child of one already chosen — so we get the distinct
 * top-level branches (Advance, Classical, Exchange, Panov, …) rather than one
 * branch plus four of its sub-variations.
 */
export function selectVariations(root: ResolvedOpening, book: TrieNode, max = MAX_VARIATIONS): ResolvedOpening[] {
  const named = variationsOf(root.uci).filter((v) => v.name.includes(":") && v.name !== root.name);
  // Fall back to bare-named variations only when the opening has no sub-named lines.
  const pool = named.length > 0 ? named : variationsOf(root.uci).filter((v) => v.name !== root.name);
  if (pool.length === 0) return [];

  const scored = pool
    .map((v) => ({ v, pop: popularityOf(book, v.san) ?? 0 }))
    .sort((a, b) => b.pop - a.pop || a.v.ply - b.v.ply || a.v.name.localeCompare(b.v.name));

  const picked: ResolvedOpening[] = [];
  const seenNames = new Set<string>();
  for (const { v } of scored) {
    if (seenNames.has(v.name)) continue;
    // A parent aggregates its children's games, so it always outranks them and is
    // seen first; skipping prefix-clashes therefore keeps the top-level branch.
    if (picked.some((p) => isPrefix(p.san, v.san) || isPrefix(v.san, p.san))) continue;
    picked.push(v);
    seenNames.add(v.name);
    if (picked.length >= max) break;
  }
  return picked;
}

/**
 * Build the parallel `variations` + seed `lines` for an opening. `lines[i].moves`
 * is the variation's defining move-order; the engine extends it afterwards.
 */
export function buildOpeningSeeds(
  root: ResolvedOpening,
  book: TrieNode,
  max = MAX_VARIATIONS,
): { variations: OpeningVariation[]; lines: RepertoireLine[] } {
  const variations: OpeningVariation[] = [];
  const lines: RepertoireLine[] = [];

  // The mainline: the opening itself.
  variations.push({
    eco: root.eco,
    name: root.name,
    line: root.san,
    popularity: popularityOf(book, root.san),
    tag: "mainline",
  });
  lines.push({ moves: root.san, rationale: `${root.name} — the main line.`, tag: "mainline" });

  for (const v of selectVariations(root, book, max)) {
    const popularity = popularityOf(book, v.san);
    variations.push({
      eco: v.eco,
      name: v.name,
      line: v.san,
      popularity,
      tag: tagForName(v.name),
    });
    lines.push({ moves: v.san, rationale: rationaleFor(v, popularity), tag: "mainline" });
  }

  return { variations, lines };
}

/**
 * Pick the engine-best line for our colour once lines are extended. `evalCp` is
 * White-POV centipawns at the end of the line, so White wants the maximum and
 * Black the minimum. Returns null when no line carries an evaluation.
 */
export function pickBestLine(lines: RepertoireLine[], color: OpeningColor): number | null {
  let best: number | null = null;
  let bestCp = color === "white" ? -Infinity : Infinity;
  lines.forEach((line, i) => {
    const cp = line.evalCp;
    if (cp === null || cp === undefined) return;
    if (color === "white" ? cp > bestCp : cp < bestCp) {
      bestCp = cp;
      best = i;
    }
  });
  return best;
}
