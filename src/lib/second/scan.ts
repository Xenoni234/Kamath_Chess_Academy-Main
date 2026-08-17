/**
 * The shared whole-game scan behind the tactical and behavioural profiles.
 *
 * Both profiles need the same thing — every one of the opponent's own moves,
 * engine-graded, with the clock context around it — and the engine work is by
 * far the most expensive part of the pipeline. Running it once and deriving both
 * profiles from the result costs half what two scans would.
 *
 * This is deliberately separate from `weakness.ts`, which grades plies 5-20 only
 * (the opening, where tactics are rarest) and aggregates by position rather than
 * keeping per-move records.
 */
import { analyzePositions } from "@/lib/engine/serverEngine";
import { buildLineFromSan } from "@/lib/engine/analysis";
import { moveAccuracy, scoreToCentipawns, winPercent } from "@/lib/engine/classify";
import type { WeightedGame } from "@/lib/second/types";

/**
 * Games scanned. This is the only stage whose cost scales with game count —
 * roughly 130 engine positions per game once before/after pairs are counted —
 * so it is deliberately NOT the ingest budget. Ingest breadth (repertoire
 * coverage) and scan depth (tactical/behavioural evidence) are separate calls.
 */
export const SCAN_MAX_GAMES = 200;

/** Skip the opening: weakness.ts covers it, and it is mostly memorised anyway. */
const MIN_PLY = 16;
/** Guard the position budget against a handful of enormous games. */
const MAX_PLY = 120;

const SHALLOW = { depth: 12, threads: 1, totalTimeoutMs: 10 * 60 * 1000 };
const DEEP = { depth: 18, threads: 1, totalTimeoutMs: 6 * 60 * 1000 };

/** A single graded move by the opponent. */
export type GradedMove = {
  /** Index into the scanned-games array, so game-level context can be rejoined. */
  gameIndex: number;
  ply: number;
  fenBefore: string;
  theirUci: string;
  /** The engine's preferred move — deep-confirmed where their move differed. */
  bestUci: string;
  /** Centipawns lost by their move, from their point of view. Never negative. */
  cpLoss: number;
  /** 0..100, the same curve the analysis board uses. */
  accuracy: number;
  /** Centiseconds they spent, increment-corrected. Null when unknowable. */
  thinkCs: number | null;
  /** Centiseconds left when they started thinking. Null when unknowable. */
  remainingBeforeCs: number | null;
};

export type ScanResult = {
  /** The games actually scanned, newest first — index matches `gameIndex`. */
  games: WeightedGame[];
  moves: GradedMove[];
  positionsEvaluated: number;
};

/**
 * Centiseconds spent on this ply, increment-corrected.
 *
 * Mirrors weakness.ts: clocks are REMAINING time, so the naive difference
 * under-reports by exactly the increment. Returns null rather than a guess when
 * the increment is unknown — an unknown increment means an unknown think time.
 */
function thinkCsAt(game: WeightedGame, ply: number): number | null {
  const clocks = game.clocks;
  if (!clocks || ply < 3) return null;
  const { incrementSec, initialSec } = game.timeControl;
  if (incrementSec === null) return null;
  const prev = clocks[ply - 3];
  const curr = clocks[ply - 1];
  if (prev === undefined || curr === undefined) return null;
  const spent = prev - curr + incrementSec * 100;
  if (spent < 0) return null;
  if (initialSec !== null && spent > initialSec * 100) return null;
  return spent;
}

/** Clock remaining when they started thinking about this ply. */
function remainingBeforeCs(game: WeightedGame, ply: number): number | null {
  const clocks = game.clocks;
  if (!clocks) return null;
  if (ply < 3) {
    return game.timeControl.initialSec !== null ? game.timeControl.initialSec * 100 : null;
  }
  return clocks[ply - 3] ?? null;
}

export async function scanGames(games: WeightedGame[], color: "w" | "b"): Promise<ScanResult> {
  // Newest first — a tournament plan cares about current form.
  const scanned = games
    .filter((g) => g.color === color)
    .sort((a, b) => b.playedAt.getTime() - a.playedAt.getTime())
    .slice(0, SCAN_MAX_GAMES);

  type Pending = {
    gameIndex: number;
    ply: number;
    fenBefore: string;
    theirUci: string;
    thinkCs: number | null;
    remainingBeforeCs: number | null;
  };

  const pending: Pending[] = [];
  const fens: string[] = [];

  for (let g = 0; g < scanned.length; g += 1) {
    const game = scanned[g];
    // `nodes` on the ingested game is truncated for memory; rebuild the full
    // tree for the games we actually scan.
    const nodes = buildLineFromSan(game.san.split(/\s+/).filter(Boolean));
    const limit = Math.min(nodes.length, MAX_PLY);
    for (let i = 0; i < limit; i += 1) {
      const node = nodes[i];
      if (node.mover !== color || node.ply < MIN_PLY) continue;
      pending.push({
        gameIndex: g,
        ply: node.ply,
        fenBefore: node.fenBefore,
        theirUci: node.uci,
        thinkCs: thinkCsAt(game, node.ply),
        remainingBeforeCs: remainingBeforeCs(game, node.ply),
      });
      // BOTH sides of the move. Using the next of their own moves as the "after"
      // position would span their move AND the opponent's reply, and report the
      // pair's combined cost as theirs.
      fens.push(node.fenBefore, node.fen);
    }
  }

  if (pending.length === 0) {
    return { games: scanned, moves: [], positionsEvaluated: 0 };
  }

  const scores = await analyzePositions(fens, SHALLOW);

  // Deep-confirm only where their move differed from the shallow best. A
  // depth-12 preference is not firm enough to call a move a mistake, and a
  // uniform deep sweep would cost several times more for the same verdicts.
  const deepIndices: number[] = [];
  for (let i = 0; i < pending.length; i += 1) {
    const before = scores[i * 2];
    if (before?.bestMove && before.bestMove !== pending[i].theirUci) deepIndices.push(i);
  }

  const deepScores =
    deepIndices.length > 0
      ? await analyzePositions(
          deepIndices.map((i) => pending[i].fenBefore),
          DEEP,
        )
      : [];
  const deepByPending = new Map<number, (typeof deepScores)[number]>();
  deepIndices.forEach((pendingIndex, k) => {
    const score = deepScores[k];
    if (score) deepByPending.set(pendingIndex, score);
  });

  const moves: GradedMove[] = [];
  for (let i = 0; i < pending.length; i += 1) {
    const before = scores[i * 2];
    const after = scores[i * 2 + 1];
    if (!before || !after) continue; // budget ran out mid-batch

    const deep = deepByPending.get(i);
    const cpBeforeWhite = scoreToCentipawns((deep ?? before).cp, (deep ?? before).mate);
    const cpAfterWhite = scoreToCentipawns(after.cp, after.mate);

    // Both converted to the mover's point of view before comparison.
    const winBefore = winPercent(color === "w" ? cpBeforeWhite : -cpBeforeWhite);
    const winAfter = winPercent(color === "w" ? cpAfterWhite : -cpAfterWhite);
    const cpLoss = Math.max(
      0,
      color === "w" ? cpBeforeWhite - cpAfterWhite : cpAfterWhite - cpBeforeWhite,
    );

    moves.push({
      gameIndex: pending[i].gameIndex,
      ply: pending[i].ply,
      fenBefore: pending[i].fenBefore,
      theirUci: pending[i].theirUci,
      bestUci: deep?.bestMove || before.bestMove,
      cpLoss,
      accuracy: moveAccuracy(winBefore, winAfter),
      thinkCs: pending[i].thinkCs,
      remainingBeforeCs: pending[i].remainingBeforeCs,
    });
  }

  return { games: scanned, moves, positionsEvaluated: fens.length + deepIndices.length };
}
