/**
 * Game-tree helpers shared by the analysis board and play-vs-engine.
 *
 * The board keeps a flat mainline rather than a full variation tree: playing a
 * move from an earlier position truncates the line from that point, and the
 * originally loaded game is kept separately so it can be restored.
 */
import { Chess } from "chess.js";
import {
  centipawnLoss,
  classifyMove,
  moveAccuracy,
  scoreToCentipawns,
  winPercent,
  type MoveClassification,
} from "./classify";
import { sideToMove, uciToMove } from "./uci";

export type PositionNode = {
  /** 1-based half-move number. Ply 1 is the position after White's first move. */
  ply: number;
  /** FEN of the position this move led to. */
  fen: string;
  /** FEN of the position the move was played from. */
  fenBefore: string;
  san: string;
  uci: string;
  mover: "w" | "b";
};

export type MoveAnalysis = {
  ply: number;
  playedSan: string;
  bestMoveSan: string;
  /** White-POV centipawns before and after the move. */
  evalBefore: number;
  evalAfter: number;
  cpLoss: number;
  accuracy: number;
  classification: MoveClassification;
};

export const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

/**
 * Replay UCI moves from a root position into nodes. Stops at the first illegal
 * move rather than throwing, so a partially corrupt move list still loads.
 */
export function buildLine(rootFen: string, uciMoves: string[]): PositionNode[] {
  const nodes: PositionNode[] = [];
  let chess: Chess;

  try {
    chess = new Chess(rootFen);
  } catch {
    return nodes;
  }

  for (const uci of uciMoves) {
    const fenBefore = chess.fen();
    const mover = sideToMove(fenBefore);

    try {
      const move = chess.move(uciToMove(uci));
      if (!move) break;
      nodes.push({
        ply: nodes.length + 1,
        fen: chess.fen(),
        fenBefore,
        san: move.san,
        uci,
        mover,
      });
    } catch {
      break;
    }
  }

  return nodes;
}

/** Same as `buildLine` but from a PGN. Returns null when the PGN will not parse. */
export function buildLineFromPgn(pgn: string): { rootFen: string; nodes: PositionNode[] } | null {
  try {
    const chess = new Chess();
    chess.loadPgn(pgn);
    const history = chess.history({ verbose: true });
    if (history.length === 0) return null;

    // `history` carries `before`/`after` FENs, so the line can be rebuilt
    // without replaying from scratch.
    const nodes: PositionNode[] = history.map((move, index) => ({
      ply: index + 1,
      fen: move.after,
      fenBefore: move.before,
      san: move.san,
      uci: `${move.from}${move.to}${move.promotion ?? ""}`,
      mover: move.color,
    }));

    return { rootFen: history[0].before, nodes };
  } catch {
    return null;
  }
}

/**
 * Same as `buildLine` but from SAN moves — the shape the Lichess games API
 * returns in its ndjson `moves` field.
 */
export function buildLineFromSan(sanMoves: string[], rootFen = START_FEN): PositionNode[] {
  const nodes: PositionNode[] = [];
  let chess: Chess;

  try {
    chess = new Chess(rootFen);
  } catch {
    return nodes;
  }

  for (const san of sanMoves) {
    const fenBefore = chess.fen();
    try {
      const move = chess.move(san);
      if (!move) break;
      nodes.push({
        ply: nodes.length + 1,
        fen: chess.fen(),
        fenBefore,
        san: move.san,
        uci: `${move.from}${move.to}${move.promotion ?? ""}`,
        mover: move.color,
      });
    } catch {
      break;
    }
  }

  return nodes;
}

/** The FEN shown at a given ply. Ply 0 is the root position. */
export function fenAtPly(rootFen: string, nodes: PositionNode[], ply: number): string {
  if (ply <= 0) return rootFen;
  return nodes[Math.min(ply, nodes.length) - 1]?.fen ?? rootFen;
}

export type ScoredPosition = {
  cp: number | null;
  mate: number | null;
  /** Engine's preferred move at this position, in UCI. */
  bestMove: string;
};

/**
 * Turn a per-position evaluation sweep into per-move quality.
 *
 * `scores` must hold one entry per position in the line *including* the root,
 * i.e. `nodes.length + 1` entries: `scores[i]` is the evaluation of the
 * position before `nodes[i]`, and `scores[i + 1]` the one after it.
 */
export function buildMoveAnalyses(
  nodes: PositionNode[],
  scores: ScoredPosition[],
): MoveAnalysis[] {
  const analyses: MoveAnalysis[] = [];

  for (let i = 0; i < nodes.length; i += 1) {
    const before = scores[i];
    const after = scores[i + 1];
    if (!before || !after) break;

    const node = nodes[i];
    const evalBefore = scoreToCentipawns(before.cp, before.mate);
    const evalAfter = scoreToCentipawns(after.cp, after.mate);
    const cpLoss = centipawnLoss(evalBefore, evalAfter, node.mover);
    const isTopMove = before.bestMove !== "" && before.bestMove === node.uci;

    // Win percentages must be from the mover's point of view.
    const sign = node.mover === "w" ? 1 : -1;
    const winBefore = winPercent(sign * evalBefore);
    const winAfter = winPercent(sign * evalAfter);

    analyses.push({
      ply: node.ply,
      playedSan: node.san,
      bestMoveSan: sanForUci(node.fenBefore, before.bestMove),
      evalBefore,
      evalAfter,
      cpLoss,
      accuracy: moveAccuracy(winBefore, winAfter),
      classification: classifyMove({ cpLoss, isTopMove }),
    });
  }

  return analyses;
}

/** Render a single UCI move as SAN in the given position. Empty on failure. */
export function sanForUci(fen: string, uci: string): string {
  if (!uci) return "";
  try {
    const chess = new Chess(fen);
    const move = chess.move(uciToMove(uci));
    return move?.san ?? "";
  } catch {
    return "";
  }
}

/** Per-side accuracy summary over a set of move analyses. */
export function summariseAccuracy(analyses: MoveAnalysis[], nodes: PositionNode[]) {
  const byPly = new Map(nodes.map((node) => [node.ply, node.mover]));
  const white: number[] = [];
  const black: number[] = [];
  const counts = { white: emptyCounts(), black: emptyCounts() };

  for (const analysis of analyses) {
    const mover = byPly.get(analysis.ply);
    if (mover === "w") {
      white.push(analysis.accuracy);
      counts.white[analysis.classification] += 1;
    } else if (mover === "b") {
      black.push(analysis.accuracy);
      counts.black[analysis.classification] += 1;
    }
  }

  return {
    white: { accuracy: average(white), counts: counts.white },
    black: { accuracy: average(black), counts: counts.black },
  };
}

function emptyCounts(): Record<MoveClassification, number> {
  return { best: 0, excellent: 0, good: 0, inaccuracy: 0, mistake: 0, blunder: 0 };
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 10) / 10;
}
