/**
 * Pure UCI helpers — no React, no DOM, no Node APIs.
 *
 * Shared by the browser worker hook (src/hooks/useStockfish.ts) and the
 * Node-side engine used by report generation (src/lib/engine/serverEngine.ts),
 * so both read the engine identically.
 */
import { Chess } from "chess.js";

export type EngineLine = {
  /** 1-based MultiPV index. Line 1 is the engine's best. */
  multipv: number;
  depth: number;
  seldepth?: number;
  /** Centipawns, normalised to White's point of view. Null when mate is set. */
  cp: number | null;
  /** Moves to mate, normalised to White (positive = White mates). */
  mate: number | null;
  /** Principal variation in UCI (e2e4), first entry is the move itself. */
  pv: string[];
  nodes?: number;
  nps?: number;
  timeMs?: number;
};

export type BestMove = {
  bestMove: string;
  ponder?: string;
};

/** `w` or `b` from a FEN's second field. Falls back to White on a malformed FEN. */
export function sideToMove(fen: string): "w" | "b" {
  return fen.split(/\s+/)[1] === "b" ? "b" : "w";
}

/**
 * Stockfish reports scores from the side-to-move's point of view. Everything
 * downstream (eval bar, classification, reports) assumes White's, so flip when
 * Black is to move.
 */
export function toWhitePov<T extends number | null>(score: T, turn: "w" | "b"): T {
  if (score === null) return score;
  return (turn === "b" ? -score : score) as T;
}

export function setOption(name: string, value: string | number | boolean): string {
  return `setoption name ${name} value ${String(value)}`;
}

function readInt(tokens: string[], index: number): number | undefined {
  const raw = tokens[index];
  if (raw === undefined) return undefined;
  const value = Number.parseInt(raw, 10);
  return Number.isNaN(value) ? undefined : value;
}

/**
 * Parse an `info` line into a line snapshot, with scores already flipped to
 * White's point of view. Returns null for lines that carry no score — the
 * `info depth N currmove ...` progress spam, and `info string ...` banners.
 */
export function parseInfoLine(line: string, fen: string): EngineLine | null {
  if (!line.startsWith("info ") || line.includes(" currmove ")) return null;

  const tokens = line.split(/\s+/);
  const scoreIndex = tokens.indexOf("score");
  if (scoreIndex === -1) return null;

  const turn = sideToMove(fen);
  let cp: number | null = null;
  let mate: number | null = null;

  const scoreType = tokens[scoreIndex + 1];
  const scoreValue = readInt(tokens, scoreIndex + 2);
  if (scoreValue === undefined) return null;

  if (scoreType === "cp") {
    cp = toWhitePov(scoreValue, turn);
  } else if (scoreType === "mate") {
    mate = toWhitePov(scoreValue, turn);
  } else {
    return null;
  }

  const pvIndex = tokens.indexOf("pv");
  const pv = pvIndex === -1 ? [] : tokens.slice(pvIndex + 1).filter(Boolean);

  const depthIndex = tokens.indexOf("depth");
  const multipvIndex = tokens.indexOf("multipv");
  const seldepthIndex = tokens.indexOf("seldepth");
  const nodesIndex = tokens.indexOf("nodes");
  const npsIndex = tokens.indexOf("nps");
  const timeIndex = tokens.indexOf("time");

  return {
    multipv: (multipvIndex === -1 ? undefined : readInt(tokens, multipvIndex + 1)) ?? 1,
    depth: (depthIndex === -1 ? undefined : readInt(tokens, depthIndex + 1)) ?? 0,
    seldepth: seldepthIndex === -1 ? undefined : readInt(tokens, seldepthIndex + 1),
    cp,
    mate,
    pv,
    nodes: nodesIndex === -1 ? undefined : readInt(tokens, nodesIndex + 1),
    nps: npsIndex === -1 ? undefined : readInt(tokens, npsIndex + 1),
    timeMs: timeIndex === -1 ? undefined : readInt(tokens, timeIndex + 1),
  };
}

export function parseBestMove(line: string): BestMove | null {
  if (!line.startsWith("bestmove")) return null;
  const tokens = line.split(/\s+/);
  const bestMove = tokens[1];
  if (!bestMove) return null;
  const ponderIndex = tokens.indexOf("ponder");
  return {
    bestMove,
    ponder: ponderIndex === -1 ? undefined : tokens[ponderIndex + 1],
  };
}

/** `e7e8q` -> `{ from: "e7", to: "e8", promotion: "q" }`. */
export function uciToMove(uci: string) {
  return {
    from: uci.slice(0, 2),
    to: uci.slice(2, 4),
    promotion: uci.length > 4 ? uci[4].toLowerCase() : undefined,
  };
}

/**
 * Convert a principal variation from UCI to SAN for display. Stops at the first
 * move the position rejects rather than throwing, so a truncated or stale PV
 * still renders what it can.
 */
export function pvToSan(fen: string, pv: string[], limit = 12): string[] {
  const san: string[] = [];
  let chess: Chess;

  try {
    chess = new Chess(fen);
  } catch {
    return san;
  }

  for (const uci of pv.slice(0, limit)) {
    try {
      const move = chess.move(uciToMove(uci));
      if (!move) break;
      san.push(move.san);
    } catch {
      break;
    }
  }

  return san;
}

/** Pull the score out of a line, defaulting to a level position when absent. */
export function scoreFromLine(line: EngineLine | undefined): {
  cp: number | null;
  mate: number | null;
} {
  if (!line) return { cp: 0, mate: null };
  return { cp: line.cp, mate: line.mate };
}

/** `+1.24`, `-0.30`, `M4`, `-M2` — the eval label used across the analysis UI. */
export function formatEval(cp: number | null, mate: number | null): string {
  if (mate !== null) {
    return `${mate > 0 ? "" : "-"}M${Math.abs(mate)}`;
  }
  if (cp === null) return "0.00";
  const pawns = cp / 100;
  return `${pawns > 0 ? "+" : pawns < 0 ? "-" : ""}${Math.abs(pawns).toFixed(2)}`;
}
