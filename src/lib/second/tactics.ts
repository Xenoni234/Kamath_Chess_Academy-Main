/**
 * Track F6 — tactical profiling.
 *
 * Which tactics does this opponent miss, and which do they land? Derived from
 * the shared whole-game scan (`scan.ts`) by classifying the motif that
 * Stockfish's preferred move exploits, then checking whether they found it.
 *
 * Two properties make this trustworthy enough for tournament preparation:
 *
 *  1. Every motif reported has a MEASURED precision (see lib/tactics/motifs.ts
 *     and scripts/validateMotifs.ts). Motifs that could not clear the bar are
 *     not reported at all — `pin` is excluded for exactly this reason.
 *  2. Every rate carries its denominator and a 95% Wilson interval. A motif seen
 *     four times produces an interval so wide it is obviously unusable, rather
 *     than a confident-looking "50%".
 *
 * This does no engine work: it consumes an existing scan, because the
 * behavioural profile needs the same grading and the engine pass is by far the
 * most expensive part of the pipeline.
 */
import { MOTIF_PRECISION, SHIPPABLE_MOTIFS, detectMotifs, type Motif } from "@/lib/tactics/motifs";
import { wilson } from "@/lib/second/stats";
import type { GradedMove } from "@/lib/second/scan";
import type { MotifStat, TacticalProfile } from "@/lib/second/types";

/** A move must lose at least this much for a missed tactic to count as missed. */
const MISS_CP_LOSS = 100;

/**
 * Below this many opportunities a motif is reported as "insufficient data"
 * rather than as a rate. Six is less a statistical threshold than a refusal to
 * print a percentage derived from two events.
 */
export const MIN_OPPORTUNITIES = 6;

export function profileTactics(moves: GradedMove[], gamesScanned: number): TacticalProfile {
  const tally = new Map<Motif, { opportunities: number; found: number; missed: number }>(
    SHIPPABLE_MOTIFS.map((m) => [m, { opportunities: 0, found: 0, missed: 0 }] as const),
  );

  for (const move of moves) {
    if (!move.bestUci) continue;

    // An "opportunity" is a position where the engine's best move executed this
    // motif — not merely one where the motif existed somewhere on the board.
    const bestMotifs = detectMotifs(move.fenBefore, move.bestUci);
    if (bestMotifs.size === 0) continue;

    const theirMotifs = detectMotifs(move.fenBefore, move.theirUci);

    for (const motif of bestMotifs) {
      const slot = tally.get(motif);
      if (!slot) continue; // not in SHIPPABLE_MOTIFS
      slot.opportunities += 1;
      // Credit executing the motif even by a different move — the point is
      // whether they saw the idea, not whether they matched the engine exactly.
      if (theirMotifs.has(motif)) slot.found += 1;
      else if (move.cpLoss >= MISS_CP_LOSS) slot.missed += 1;
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
    gamesScanned,
    positionsScanned: moves.length,
    motifs,
    minOpportunities: MIN_OPPORTUNITIES,
  };
}
