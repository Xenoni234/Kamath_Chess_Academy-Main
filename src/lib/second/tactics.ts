/**
 * Track F6 — tactical profiling.
 *
 * Which tactics does this opponent miss, and which do they land? Answered by
 * engine-grading their own moves across whole games and classifying the motif
 * the engine's preferred move exploits.
 *
 * Two properties make this trustworthy enough for tournament preparation:
 *
 *  1. Every motif reported has a MEASURED precision (see lib/tactics/motifs.ts
 *     and scripts/validateMotifs.ts). Motifs that could not clear the bar are
 *     not reported at all.
 *  2. Every rate carries its denominator and a 95% Wilson interval. A motif
 *     seen four times produces an interval so wide it is obviously unusable,
 *     rather than a confident-looking "50%".
 *
 * This is a genuinely new scan, not an extension of weakness.ts: that one
 * grades plies 5-20, the opening, which is where tactics are least common.
 */
import { analyzePositions } from "@/lib/engine/serverEngine";
import { buildLineFromSan } from "@/lib/engine/analysis";
import { scoreToCentipawns } from "@/lib/engine/classify";
import {
  MOTIF_PRECISION,
  SHIPPABLE_MOTIFS,
  detectMotifs,
  type Motif,
} from "@/lib/tactics/motifs";
import type { TacticalProfile, MotifStat, WeightedGame } from "@/lib/second/types";

/**
 * Games to scan tactically — deliberately NOT the ingest budget.
 *
 * This is the first stage in the pipeline whose cost scales with game count:
 * roughly 65 engine positions per game. At 300 games that is ~20k positions in
 * pass 1 (~2.5 min across 8 engines) plus a deep confirm pass; at 1000 it would
 * be most of the job ceiling on its own. Ingest breadth and tactical depth are
 * separate concerns, so they get separate budgets.
 */
export const TACTICAL_SCAN_MAX_GAMES = 300;

/** Skip the opening: weakness.ts already covers it and tactics are rare there. */
const MIN_PLY = 16;
/** Guard against absurdly long games skewing the position budget. */
const MAX_PLY = 120;

/** A move must lose at least this much for a missed tactic to count as missed. */
const MISS_CP_LOSS = 100;

/**
 * Below this many opportunities a motif is reported as "insufficient data"
 * rather than as a rate. Six is not a statistical threshold so much as a
 * refusal to print a percentage derived from two events.
 */
export const MIN_OPPORTUNITIES = 6;

const SHALLOW = { depth: 12, threads: 1, totalTimeoutMs: 8 * 60 * 1000 };
const DEEP = { depth: 18, threads: 1, totalTimeoutMs: 6 * 60 * 1000 };

/** 95% Wilson score interval — behaves sanely at small n, unlike normal approx. */
function wilson(successes: number, total: number): { low: number; high: number } {
  if (total === 0) return { low: 0, high: 0 };
  const z = 1.96;
  const p = successes / total;
  const denom = 1 + (z * z) / total;
  const centre = p + (z * z) / (2 * total);
  const margin = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * total)) / total);
  return {
    low: Math.max(0, (centre - margin) / denom),
    high: Math.min(1, (centre + margin) / denom),
  };
}

type Candidate = {
  fenBefore: string;
  theirUci: string;
  /** Index into the shallow score array, so pass 2 can be matched back. */
  index: number;
};

export async function profileTactics(
  games: WeightedGame[],
  color: "w" | "b",
): Promise<TacticalProfile> {
  // Newest first — recent form is what a tournament plan needs.
  const scanned = games
    .filter((g) => g.color === color)
    .sort((a, b) => b.playedAt.getTime() - a.playedAt.getTime())
    .slice(0, TACTICAL_SCAN_MAX_GAMES);

  // Rebuild full trees only for the games actually scanned; `nodes` on the
  // ingested game is truncated for memory, and tactics live past that depth.
  const positions: { fenBefore: string; theirUci: string }[] = [];
  for (const game of scanned) {
    const nodes = buildLineFromSan(game.san.split(/\s+/).filter(Boolean));
    const limit = Math.min(nodes.length, MAX_PLY);
    for (let i = 0; i < limit; i += 1) {
      const node = nodes[i];
      if (node.mover !== color || node.ply < MIN_PLY) continue;
      positions.push({ fenBefore: node.fenBefore, theirUci: node.uci });
    }
  }

  const empty: TacticalProfile = {
    gamesScanned: scanned.length,
    positionsScanned: 0,
    motifs: [],
    minOpportunities: MIN_OPPORTUNITIES,
  };
  if (positions.length === 0) return empty;

  // Pass 1 — cheap sweep. `analyzePositions` returns the engine's preferred move
  // alongside the score, which is what the motif classifier needs.
  const beforeScores = await analyzePositions(
    positions.map((p) => p.fenBefore),
    SHALLOW,
  );

  const tally = new Map<Motif, { opportunities: number; found: number; missed: number }>(
    SHIPPABLE_MOTIFS.map((m) => [m, { opportunities: 0, found: 0, missed: 0 }] as const),
  );

  // Pass 2 — re-derive the best move deeply, but only where they may have gone
  // wrong. A depth-12 "best move" is not reliable enough to accuse someone of
  // missing a tactic, and a uniform deep sweep would cost several times more.
  const candidates: Candidate[] = [];
  for (let i = 0; i < positions.length; i += 1) {
    const score = beforeScores[i];
    if (!score?.bestMove) continue;
    if (score.bestMove !== positions[i].theirUci) {
      candidates.push({ ...positions[i], index: i });
    }
  }

  const deepScores =
    candidates.length > 0
      ? await analyzePositions(
          candidates.map((c) => c.fenBefore),
          DEEP,
        )
      : [];

  const deepByIndex = new Map<number, (typeof deepScores)[number]>();
  candidates.forEach((candidate, i) => {
    const score = deepScores[i];
    if (score) deepByIndex.set(candidate.index, score);
  });

  let graded = 0;
  for (let i = 0; i < positions.length; i += 1) {
    const shallow = beforeScores[i];
    if (!shallow?.bestMove) continue;

    const deep = deepByIndex.get(i);
    const best = deep?.bestMove ?? shallow.bestMove;
    const { fenBefore, theirUci } = positions[i];
    graded += 1;

    const bestMotifs = detectMotifs(fenBefore, best);
    if (bestMotifs.size === 0) continue;

    const theirMotifs = detectMotifs(fenBefore, theirUci);

    // How much the position moved. Both scores are the position BEFORE a move,
    // so their move's cost is measured against the engine's line from here.
    const bestCp = scoreToCentipawns(
      (deep ?? shallow).cp,
      (deep ?? shallow).mate,
    );
    const afterTheirs = beforeScores[i + 1];
    const theirCp = afterTheirs ? scoreToCentipawns(afterTheirs.cp, afterTheirs.mate) : null;
    // Positive = how much worse their move left it, from their point of view.
    const cpLoss =
      theirCp === null ? null : color === "w" ? bestCp - theirCp : theirCp - bestCp;

    for (const motif of bestMotifs) {
      const slot = tally.get(motif);
      if (!slot) continue; // not a shippable motif
      slot.opportunities += 1;
      if (theirMotifs.has(motif)) slot.found += 1;
      else if (cpLoss !== null && cpLoss >= MISS_CP_LOSS) slot.missed += 1;
    }
  }

  const motifs: MotifStat[] = [];
  for (const motif of SHIPPABLE_MOTIFS) {
    const slot = tally.get(motif);
    if (!slot || slot.opportunities === 0) continue;
    const interval = wilson(slot.missed, slot.opportunities);
    motifs.push({
      motif,
      opportunities: slot.opportunities,
      found: slot.found,
      missed: slot.missed,
      missRate: slot.missed / slot.opportunities,
      missRateLow: interval.low,
      missRateHigh: interval.high,
      detectorPrecision: MOTIF_PRECISION[motif],
    });
  }

  // Most-missed first — that is the one to steer the game towards.
  motifs.sort((a, b) => b.missed - a.missed || b.opportunities - a.opportunities);

  return {
    gamesScanned: scanned.length,
    positionsScanned: graded,
    motifs,
    minOpportunities: MIN_OPPORTUNITIES,
  };
}
