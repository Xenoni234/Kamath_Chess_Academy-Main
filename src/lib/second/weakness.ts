/**
 * Track F2 — weakness detection.
 *
 * A weakness is a position the opponent reaches often, plays *badly*, and
 * (ideally) burns clock on. We aggregate their recurring decision positions
 * from the ingested games, engine-grade the most frequent ones with the same
 * accuracy curves the analysis board uses, and rank by a composite that
 * amplifies low accuracy when they also think long there.
 */
import { Chess } from "chess.js";
import { analyzePositions } from "@/lib/engine/serverEngine";
import {
  moveAccuracy,
  scoreToCentipawns,
  winPercent,
} from "@/lib/engine/classify";
import type { WeaknessPosition, WeightedGame } from "@/lib/second/types";

const MIN_PLY = 5;
/** Keep grading in the opening / early-middlegame — the repertoire-prep zone. */
const MAX_PLY = 20;
/** A position must carry at least this weighted frequency to be worth grading. */
const MIN_WEIGHT = 0.6;
/** Cap the engine work: grade at most this many decision positions (2 fens each). */
const MAX_POSITIONS = 30;
/** Only positions below this accuracy count as weaknesses. */
const ACCURACY_CEILING = 88;

export type WeaknessBudget = { depth: number; threads: number; totalTimeoutMs: number };
const DEFAULT_BUDGET: WeaknessBudget = { depth: 12, threads: 2, totalTimeoutMs: 5 * 60 * 1000 };

type MoveAgg = { uci: string; fenAfter: string; weight: number };
type PositionAgg = {
  fen: string;
  ply: number;
  mover: "w" | "b";
  line: string[];
  moves: Map<string, MoveAgg>;
  totalWeight: number;
  clockSamples: number[];
};

/** Centiseconds the mover spent on the ply (prev same-side remaining − current). */
function clockSpentCs(clocks: number[] | undefined, ply: number): number | null {
  if (!clocks || ply < 3) return null;
  const prev = clocks[ply - 3];
  const curr = clocks[ply - 1];
  if (prev === undefined || curr === undefined) return null;
  const spent = prev - curr;
  return spent >= 0 ? spent : null;
}

export async function detectWeaknesses(
  games: WeightedGame[],
  color: "w" | "b",
  budget: WeaknessBudget = DEFAULT_BUDGET,
): Promise<WeaknessPosition[]> {
  // 1. Aggregate the opponent's recurring decision positions.
  const positions = new Map<string, PositionAgg>();

  for (const game of games) {
    if (game.color !== color) continue;
    const path: string[] = [];
    const limit = Math.min(game.nodes.length, MAX_PLY);
    for (let i = 0; i < limit; i += 1) {
      const node = game.nodes[i];
      if (node.mover !== color || node.ply < MIN_PLY) {
        path.push(node.san);
        continue;
      }

      const key = node.fenBefore;
      let agg = positions.get(key);
      if (!agg) {
        agg = { fen: key, ply: node.ply, mover: node.mover, line: [...path], moves: new Map(), totalWeight: 0, clockSamples: [] };
        positions.set(key, agg);
      }
      const mv = agg.moves.get(node.san) ?? { uci: node.uci, fenAfter: node.fen, weight: 0 };
      mv.weight += game.weight;
      agg.moves.set(node.san, mv);
      agg.totalWeight += game.weight;

      const spent = clockSpentCs(game.clocks, node.ply);
      if (spent !== null) agg.clockSamples.push(spent);

      path.push(node.san);
    }
  }

  // 2. Rank by frequency and grade the top slice with the engine.
  const ranked = [...positions.values()]
    .filter((p) => p.totalWeight >= MIN_WEIGHT)
    .sort((a, b) => b.totalWeight - a.totalWeight)
    .slice(0, MAX_POSITIONS);

  if (ranked.length === 0) return [];

  const fens: string[] = [];
  const slots = ranked.map((agg) => {
    const [bestSan, mv] = [...agg.moves.entries()].sort((a, b) => b[1].weight - a[1].weight)[0];
    const offset = fens.length;
    fens.push(agg.fen, mv.fenAfter);
    return { agg, theirMoveSan: bestSan, theirMoveUci: mv.uci, offset };
  });

  const scores = await analyzePositions(fens, budget);

  // 3. Score each graded position.
  const results: WeaknessPosition[] = [];
  for (const slot of slots) {
    const before = scores[slot.offset];
    const after = scores[slot.offset + 1];
    if (!before || !after) continue; // budget ran out

    const cpBeforeWhite = scoreToCentipawns(before.cp, before.mate);
    const cpAfterWhite = scoreToCentipawns(after.cp, after.mate);
    const mover = slot.agg.mover;
    const winBefore = winPercent(mover === "w" ? cpBeforeWhite : -cpBeforeWhite);
    const winAfter = winPercent(mover === "w" ? cpAfterWhite : -cpAfterWhite);
    const accuracy = Math.round(moveAccuracy(winBefore, winAfter) * 10) / 10;
    if (accuracy >= ACCURACY_CEILING) continue;

    const avgClockSpent =
      slot.agg.clockSamples.length > 0
        ? Math.round((slot.agg.clockSamples.reduce((a, b) => a + b, 0) / slot.agg.clockSamples.length / 100) * 10) / 10
        : null;

    const clockFactor = avgClockSpent !== null ? 1 + Math.min(avgClockSpent, 60) / 60 : 1;
    const freqFactor = 1 + Math.log1p(slot.agg.totalWeight);
    const weaknessScore = Math.round((100 - accuracy) * clockFactor * freqFactor * 10) / 10;

    results.push({
      fen: slot.agg.fen,
      line: slot.agg.line,
      theirMove: slot.theirMoveSan,
      accuracy,
      avgClockSpent,
      weightedFrequency: Math.round(slot.agg.totalWeight * 10) / 10,
      weaknessScore,
    });
  }

  return results.sort((a, b) => b.weaknessScore - a.weaknessScore).slice(0, 8);
}

/** Reachable-from-start check for a SAN line — used to validate reconstructed lines. */
export function fenAfterLine(sans: string[]): string | null {
  const chess = new Chess();
  for (const san of sans) {
    try {
      if (!chess.move(san)) return null;
    } catch {
      return null;
    }
  }
  return chess.fen();
}
