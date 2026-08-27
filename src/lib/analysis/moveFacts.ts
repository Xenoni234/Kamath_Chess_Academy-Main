/**
 * Verified facts about one move, for the AI move explainer.
 *
 * The explainer used to hand a language model a raw FEN and ask it to "mention
 * the relevant tactics". Models cannot reliably decode 64 squares from a string,
 * so they invented tactics that were not in the position — confidently, and in a
 * teaching context. This module removes the guessing: everything the AI is
 * allowed to say is computed here first, deterministically.
 *
 * The rule is the one the rest of Second AI already follows: engine analysis and
 * chess.js decide what is true, the AI only puts it into words.
 *
 * Pure and synchronous — chess.js plus the validated motif detector, no engine
 * and no network — so it is cheap to call and testable offline. Anything that
 * cannot be computed is left absent rather than defaulted; a missing evaluation
 * must never arrive at the prompt as "0.00" (a confident claim of equality).
 */
import { Chess, type Color, type PieceSymbol, type Square } from "chess.js";
import { buildLine } from "@/lib/engine/analysis";
import { sideToMove } from "@/lib/engine/uci";
import {
  CLASSIFICATION_META,
  centipawnLoss,
  classifyMove,
  moveAccuracy,
  scoreToCentipawns,
  winPercentFromScore,
  type MoveClassification,
} from "@/lib/engine/classify";
import {
  MOTIF_PRECISION,
  SHIPPABLE_MOTIFS,
  VALUE,
  attackersOf,
  detectMotifs,
  isHanging,
  type Motif,
} from "@/lib/tactics/motifs";
import type { MultiPvMove } from "@/lib/engine/serverEngine";

/** Engine score of a position, White's point of view (the engine convention). */
export type Score = { cp: number | null; mate: number | null };

export type MoveFactsInput = {
  /** The position the move was played FROM. */
  fenBefore: string;
  /** The move being explained, UCI (e2e4, e7e8q). */
  playedUci: string;
  /** Engine's top lines at `fenBefore`, White-POV, each carrying its full PV. */
  lines: MultiPvMove[];
  /** Engine's read of the position AFTER the played move, White-POV. */
  after?: (Score & { pv: string[] }) | null;
};

export type MoveDescription = {
  san: string;
  /** "knight", "pawn", … */
  piece: string;
  from: string;
  to: string;
  isCapture: boolean;
  /** What it took, e.g. "bishop". Null when it is not a capture. */
  captured: string | null;
  isCheck: boolean;
  isMate: boolean;
  isCastle: boolean;
  isPromotion: boolean;
  /** Only motifs cleared for use (see SHIPPABLE_MOTIFS). */
  motifs: Motif[];
};

export type MoveFacts = {
  fen: string;
  /** The side that played the move — the student we address as "you". */
  student: "White" | "Black";
  moveNumber: number;
  phase: "opening" | "middlegame" | "endgame";
  /**
   * Complete piece placement, per side, as readable text ("Ke1, Qh5, Bc4,
   * pawns a2 b2 …"). A FEN is the same information, but models decode it
   * unreliably and then describe pieces that are not on the board; given the
   * list in plain text they have no reason to guess.
   */
  pieces: { white: string; black: string };
  /**
   * Who actually contests the square the move lands on, measured before the
   * move. Models confidently invent this ("the only defender is the knight on
   * f6" when that knight does not attack the square at all), so it is stated.
   */
  target: { square: string; yours: string; theirs: string };
  /** Plain-language material count from the student's side. */
  material: string;
  inCheckBefore: boolean;
  legalMoveCount: number;
  /** True when there was literally nothing else to play. */
  forced: boolean;

  played: MoveDescription;
  /** Absent when the engine produced no line for this position. */
  best: (MoveDescription & { line: string }) | null;
  playedWasBest: boolean;

  /** Student's point of view, in pawns ("+0.35") or mate ("M4"). */
  evalBefore: string | null;
  evalAfter: string | null;
  /** Centipawns given up versus the engine's move. */
  cpLoss: number | null;
  accuracy: number | null;
  classification: MoveClassification | null;
  classificationLabel: string | null;
  symbol: string | null;

  /** How the opponent punishes the played move, when it is punishable. */
  refutation: string | null;
  /** Tactics the engine's move had that the played move did not. */
  missedMotifs: { motif: Motif; precision: number }[];
  /** Student pieces left attacked and undefended after the move. */
  hangingAfter: string[];
  alternatives: { san: string; eval: string; line: string }[];

  /**
   * Every move the explanation is permitted to name. The prompt states this
   * explicitly, and it is what a post-hoc check would validate against.
   */
  allowedMoves: string[];
};

const PIECE_NAME: Record<PieceSymbol, string> = {
  p: "pawn",
  n: "knight",
  b: "bishop",
  r: "rook",
  q: "queen",
  k: "king",
};

function fullmoveOf(fen: string): number {
  const n = Number(fen.split(" ")[5]);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/** Flip a White-POV score to the mover's point of view. */
function toMover(whiteCp: number, mover: Color): number {
  return mover === "w" ? whiteCp : -whiteCp;
}

/** "+0.35" / "-1.20" / "M4" / "-M2", from the student's side. */
function formatScore(score: Score | null | undefined, mover: Color): string | null {
  if (!score) return null;
  if (score.mate !== null) {
    const m = mover === "w" ? score.mate : -score.mate;
    return m > 0 ? `M${m}` : `-M${Math.abs(m)}`;
  }
  if (score.cp === null) return null;
  const pawns = toMover(score.cp, mover) / 100;
  return `${pawns > 0 ? "+" : ""}${pawns.toFixed(2)}`;
}

/**
 * Opening / middlegame / endgame from the position alone. Deterministic and
 * approximate — it only ever frames the advice, never carries a claim.
 */
function phaseOf(fen: string): "opening" | "middlegame" | "endgame" {
  const board = fen.split(" ")[0];
  const heavy = (board.match(/[qrbnQRBN]/g) ?? []).length;
  if (heavy <= 6) return "endgame";
  if (fullmoveOf(fen) <= 12) return "opening";
  return "middlegame";
}

/** Material from the student's side, e.g. "you are a knight up". */
function materialOf(chess: Chess, student: Color): string {
  let white = 0;
  let black = 0;
  for (const row of chess.board()) {
    for (const sq of row) {
      if (!sq || sq.type === "k") continue;
      if (sq.color === "w") white += VALUE[sq.type];
      else black += VALUE[sq.type];
    }
  }
  const diff = student === "w" ? white - black : black - white;
  if (diff === 0) return "material is level";
  const side = diff > 0 ? "up" : "down";
  const n = Math.abs(diff);
  const unit = n === 1 ? "a pawn" : n === 3 ? "a piece" : n === 5 ? "a rook" : n === 9 ? "a queen" : `${n} points`;
  return `you are ${unit} ${side}`;
}

/** Every piece of one colour, e.g. "Ke1, Qh5, Bc4, Ng1, pawns a2 b2 e4". */
function pieceList(chess: Chess, color: Color): string {
  const ORDER = "KQRBN";
  const men: string[] = [];
  const pawns: string[] = [];
  for (const row of chess.board()) {
    for (const sq of row) {
      if (!sq || sq.color !== color) continue;
      if (sq.type === "p") pawns.push(sq.square);
      else men.push(`${sq.type.toUpperCase()}${sq.square}`);
    }
  }
  men.sort((a, b) => ORDER.indexOf(a[0]) - ORDER.indexOf(b[0]) || a.localeCompare(b));
  pawns.sort();
  const parts = [...men];
  if (pawns.length) parts.push(`pawns ${pawns.join(" ")}`);
  return parts.join(", ");
}

/** Pieces of `color` that attack `square`, as "Qh5, Bc4". Empty string if none. */
function contestants(chess: Chess, square: Square, color: Color): string {
  return attackersOf(chess, square, color)
    .map((sq) => {
      const piece = chess.get(sq);
      return piece ? `${piece.type.toUpperCase()}${sq}` : "";
    })
    .filter(Boolean)
    .sort()
    .join(", ");
}

/** Replay a UCI line from `fen` into numbered SAN: "12.Nf3 Bg4 13.h3". */
function numberedLine(fen: string, uciMoves: string[], limit = 8): string {
  const nodes = buildLine(fen, uciMoves.slice(0, limit));
  if (nodes.length === 0) return "";
  let n = fullmoveOf(fen);
  const parts: string[] = [];
  nodes.forEach((node, i) => {
    if (node.mover === "w") {
      parts.push(`${n}.${node.san}`);
    } else {
      parts.push(i === 0 ? `${n}...${node.san}` : node.san);
      n++;
    }
  });
  return parts.join(" ");
}

/** What a move literally does. Returns null when it is not legal in `fen`. */
export function describeMove(fen: string, uci: string): MoveDescription | null {
  if (uci.length < 4) return null;
  let chess: Chess;
  try {
    chess = new Chess(fen);
  } catch {
    return null;
  }
  try {
    const move = chess.move({
      from: uci.slice(0, 2),
      to: uci.slice(2, 4),
      promotion: uci.length > 4 ? uci[4].toLowerCase() : undefined,
    });
    if (!move) return null;
    const motifs = [...detectMotifs(fen, uci)].filter((m) => SHIPPABLE_MOTIFS.includes(m));
    return {
      san: move.san,
      piece: PIECE_NAME[move.piece],
      from: move.from,
      to: move.to,
      isCapture: move.isCapture(),
      captured: move.captured ? PIECE_NAME[move.captured] : null,
      isCheck: chess.isCheck(),
      isMate: chess.isCheckmate(),
      // chess.js 1.4.0 documents `isCastle()` but only declares the two
      // side-specific predicates.
      isCastle: move.isKingsideCastle() || move.isQueensideCastle(),
      isPromotion: move.isPromotion(),
      motifs,
    };
  } catch {
    return null;
  }
}

/** Student pieces that are attacked and completely undefended after the move. */
function hangingCensus(fenAfter: string, student: Color): string[] {
  let chess: Chess;
  try {
    chess = new Chess(fenAfter);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const row of chess.board()) {
    for (const sq of row) {
      if (!sq || sq.color !== student || sq.type === "k") continue;
      if (isHanging(chess, sq.square as Square, student)) {
        out.push(`${PIECE_NAME[sq.type]} on ${sq.square}`);
      }
    }
  }
  return out;
}

/**
 * Assemble every verified fact about `playedUci` in `fenBefore`.
 *
 * Returns null only when the move is not legal in the position — the caller
 * should reject the request rather than explain a move that cannot be played.
 */
export function buildMoveFacts(input: MoveFactsInput): MoveFacts | null {
  const { fenBefore, playedUci, lines, after } = input;

  let chess: Chess;
  try {
    chess = new Chess(fenBefore);
  } catch {
    return null;
  }

  const mover = sideToMove(fenBefore);
  const played = describeMove(fenBefore, playedUci);
  if (!played) return null;

  const legalMoves = chess.moves();
  const bestLine = lines[0];
  const best = bestLine ? describeMove(fenBefore, bestLine.uci) : null;
  const playedWasBest = Boolean(bestLine && bestLine.uci === playedUci);

  // Engine numbers. `after` is the score of the position the played move
  // actually reached — without it there is no honest way to say what the move
  // cost, so every derived figure stays null rather than being invented.
  const beforeScore: Score | null = bestLine ? { cp: bestLine.cp, mate: bestLine.mate } : null;
  const afterScore: Score | null = after ? { cp: after.cp, mate: after.mate } : null;

  let cpLoss: number | null = null;
  let accuracy: number | null = null;
  let classification: MoveClassification | null = null;
  // Mate scores are ~10000 internally, so a missed mate "costs" five figures of
  // centipawns. That number is an artefact of the encoding, not something to
  // teach a student — the mate notation already tells the story, so the figure
  // is withheld while the classification it produced is kept.
  const mateInvolved = beforeScore?.mate != null || afterScore?.mate != null;
  if (beforeScore && afterScore) {
    const beforeWhite = scoreToCentipawns(beforeScore.cp, beforeScore.mate);
    const afterWhite = scoreToCentipawns(afterScore.cp, afterScore.mate);
    cpLoss = Math.round(centipawnLoss(beforeWhite, afterWhite, mover));
    const winBeforeWhite = winPercentFromScore(beforeScore.cp, beforeScore.mate);
    const winAfterWhite = winPercentFromScore(afterScore.cp, afterScore.mate);
    const winBefore = mover === "w" ? winBeforeWhite : 100 - winBeforeWhite;
    const winAfter = mover === "w" ? winAfterWhite : 100 - winAfterWhite;
    accuracy = Math.round(moveAccuracy(winBefore, winAfter));
    classification = classifyMove({ cpLoss, isTopMove: playedWasBest });
  }

  // The tactic the engine saw and the played move missed.
  const missedMotifs = best
    ? best.motifs
        .filter((m) => !played.motifs.includes(m))
        .map((motif) => ({ motif, precision: MOTIF_PRECISION[motif] }))
    : [];

  // How the opponent punishes it. Only meaningful when the move was not best.
  const fenAfter = (() => {
    const c = new Chess(fenBefore);
    try {
      c.move({
        from: playedUci.slice(0, 2),
        to: playedUci.slice(2, 4),
        promotion: playedUci.length > 4 ? playedUci[4].toLowerCase() : undefined,
      });
      return c.fen();
    } catch {
      return null;
    }
  })();

  const refutation =
    !playedWasBest && after?.pv?.length && fenAfter ? numberedLine(fenAfter, after.pv, 6) || null : null;

  const alternatives = lines.slice(0, 3).flatMap((line) => {
    const desc = describeMove(fenBefore, line.uci);
    if (!desc) return [];
    return [
      {
        san: desc.san,
        eval: formatScore({ cp: line.cp, mate: line.mate }, mover) ?? "unknown",
        line: numberedLine(fenBefore, line.pv, 8),
      },
    ];
  });

  // Everything the explanation may legitimately name.
  const allowed = new Set<string>([played.san]);
  if (best) allowed.add(best.san);
  for (const alt of alternatives) {
    allowed.add(alt.san);
    for (const token of alt.line.split(/\s+/)) allowed.add(token.replace(/^\d+\.+/, ""));
  }
  if (refutation) for (const token of refutation.split(/\s+/)) allowed.add(token.replace(/^\d+\.+/, ""));

  return {
    fen: fenBefore,
    student: mover === "w" ? "White" : "Black",
    moveNumber: fullmoveOf(fenBefore),
    phase: phaseOf(fenBefore),
    pieces: { white: pieceList(chess, "w"), black: pieceList(chess, "b") },
    target: {
      square: played.to,
      yours: contestants(chess, played.to as Square, mover),
      theirs: contestants(chess, played.to as Square, mover === "w" ? "b" : "w"),
    },
    material: materialOf(chess, mover),
    inCheckBefore: chess.isCheck(),
    legalMoveCount: legalMoves.length,
    forced: legalMoves.length === 1,
    played,
    best: best && bestLine ? { ...best, line: numberedLine(fenBefore, bestLine.pv, 8) } : null,
    playedWasBest,
    evalBefore: formatScore(beforeScore, mover),
    evalAfter: formatScore(afterScore, mover),
    cpLoss: mateInvolved ? null : cpLoss,
    accuracy,
    classification,
    classificationLabel: classification ? CLASSIFICATION_META[classification].label : null,
    symbol: classification ? CLASSIFICATION_META[classification].symbol : null,
    refutation,
    missedMotifs,
    hangingAfter: fenAfter ? hangingCensus(fenAfter, mover) : [],
    alternatives,
    allowedMoves: [...allowed].filter(Boolean),
  };
}
