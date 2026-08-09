/**
 * Turns imported games into real, engine-derived report statistics.
 *
 * This replaces the placeholder that scored every game with
 * `75 + Math.random() * 15`. Accuracy uses the same curves as the analysis
 * board (src/lib/engine/classify.ts), so a KCA figure is comparable with the
 * one Lichess shows for the same game.
 */
import { Chess } from "chess.js";
import { buildLineFromPgn, buildLineFromSan, buildMoveAnalyses, type MoveAnalysis, type PositionNode } from "@/lib/engine/analysis";
import { analyzePositions, type ServerScore } from "@/lib/engine/serverEngine";
import { averageAccuracy } from "@/lib/engine/classify";
import type { GameReportStats } from "@/lib/claude";

/**
 * Budget. Depth 12 costs roughly 70 ms per position on the lite build, so the
 * ceiling below lands around two minutes of engine time. The job is
 * fire-and-forget (no queue until Phase 3), so it must stay bounded.
 */
export const REPORT_BUDGET = {
  maxGames: 20,
  depth: 12,
  threads: 2,
  /** Opening moves are book; scoring them punishes theory the player knows. */
  bookPlies: 8,
  maxPositions: 1500,
  maxPliesPerGame: 120,
  totalTimeoutMs: 8 * 60 * 1000,
};

export type NormalisedGame = {
  /** Which colour the report's subject played. */
  subject: "w" | "b";
  nodes: PositionNode[];
  openingName: string;
  won: boolean;
};

type LichessGame = {
  moves?: string;
  pgn?: string;
  winner?: "white" | "black";
  opening?: { name?: string };
  players?: {
    white?: { user?: { name?: string } };
    black?: { user?: { name?: string } };
  };
};

type ChessComGame = {
  pgn?: string;
  white?: { username?: string; result?: string };
  black?: { username?: string; result?: string };
  eco?: string;
};

function nodesFor(pgn: string | undefined, moves: string | undefined): PositionNode[] {
  if (pgn) {
    const parsed = buildLineFromPgn(pgn);
    if (parsed) return parsed.nodes;
  }
  if (moves) return buildLineFromSan(moves.split(/\s+/).filter(Boolean));
  return [];
}

/** Lichess ndjson nests names under `players.<colour>.user.name`. */
export function normaliseLichessGames(raw: unknown[], username: string): NormalisedGame[] {
  const wanted = username.toLowerCase();
  const games: NormalisedGame[] = [];

  for (const entry of raw as LichessGame[]) {
    const white = entry.players?.white?.user?.name?.toLowerCase();
    const black = entry.players?.black?.user?.name?.toLowerCase();
    const subject: "w" | "b" | null = white === wanted ? "w" : black === wanted ? "b" : null;
    if (!subject) continue;

    const nodes = nodesFor(entry.pgn, entry.moves);
    if (nodes.length === 0) continue;

    games.push({
      subject,
      nodes,
      openingName: entry.opening?.name ?? "Unknown Opening",
      won: entry.winner === (subject === "w" ? "white" : "black"),
    });
  }

  return games;
}

/** Chess.com puts the names flat on `white.username` / `black.username`. */
export function normaliseChessComGames(raw: unknown[], username: string): NormalisedGame[] {
  const wanted = username.toLowerCase();
  const games: NormalisedGame[] = [];

  for (const entry of raw as ChessComGame[]) {
    const white = entry.white?.username?.toLowerCase();
    const black = entry.black?.username?.toLowerCase();
    const subject: "w" | "b" | null = white === wanted ? "w" : black === wanted ? "b" : null;
    if (!subject) continue;

    const nodes = nodesFor(entry.pgn, undefined);
    if (nodes.length === 0) continue;

    const player = subject === "w" ? entry.white : entry.black;
    games.push({
      subject,
      nodes,
      openingName: openingFromPgn(entry.pgn) ?? "Unknown Opening",
      won: player?.result === "win",
    });
  }

  return games;
}

/** Chess.com carries the opening in the PGN's ECOUrl / Opening header. */
function openingFromPgn(pgn: string | undefined): string | null {
  if (!pgn) return null;
  const named = pgn.match(/\[Opening "([^"]+)"\]/)?.[1];
  if (named) return named;
  const ecoUrl = pgn.match(/\[ECOUrl "[^"]*\/openings\/([^"]+)"\]/)?.[1];
  return ecoUrl ? ecoUrl.replace(/-/g, " ") : null;
}

type Phase = "opening" | "middlegame" | "endgame";

/** Endgame once few pieces remain; the first moves are opening by ply count. */
function phaseFor(fen: string, ply: number): Phase {
  if (ply <= 24) return "opening";

  const board = fen.split(/\s+/)[0] ?? "";
  const heavy = (board.match(/[qrbnQRBN]/g) ?? []).length;
  return heavy <= 6 ? "endgame" : "middlegame";
}

/**
 * Name the recurring problems behind a player's blunders, from the engine's
 * view of the resulting positions. Returns an empty list rather than filler
 * when nothing is detectable.
 */
function detectPatterns(blunders: Array<{ analysis: MoveAnalysis; node: PositionNode; reply: ServerScore | undefined }>): string[] {
  const counts = new Map<string, number>();
  const bump = (label: string) => counts.set(label, (counts.get(label) ?? 0) + 1);

  for (const { analysis, node, reply } of blunders) {
    // Did the player walk past a forced mate of their own?
    if (Math.abs(analysis.evalBefore) > 9000 && Math.abs(analysis.evalAfter) < 9000) {
      bump("missed forced mates");
    }

    if (phaseFor(node.fenBefore, node.ply) === "endgame") {
      bump("endgame technique");
    }

    if (!reply?.bestMove) continue;

    try {
      const chess = new Chess(node.fen);
      const move = chess.move({
        from: reply.bestMove.slice(0, 2),
        to: reply.bestMove.slice(2, 4),
        promotion: reply.bestMove.length > 4 ? reply.bestMove[4] : undefined,
      });
      if (!move) continue;

      // The refutation grabs material -> something was left hanging.
      if (move.flags.includes("c") || move.flags.includes("e")) {
        bump("hanging pieces");
      }

      // Mate delivered along the back rank by a heavy piece.
      const rank = move.to[1];
      if (chess.isCheckmate() && (rank === "1" || rank === "8") && "qr".includes(move.piece)) {
        bump("back rank tactics");
      }
    } catch {
      // An unplayable refutation tells us nothing; skip it.
    }
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([label]) => label);
}

/**
 * Evaluate the games and build the report statistics.
 *
 * Positions across all games are scored in one engine session, then split back
 * out per game. If the budget runs out mid-way, whatever was scored is used
 * and the rest of the games are dropped — never faked.
 */
export async function buildGameStats(
  username: string,
  games: NormalisedGame[],
): Promise<{ stats: GameReportStats; gamesAnalyzed: number }> {
  const selected = games.slice(0, REPORT_BUDGET.maxGames);

  // Work out which positions need scoring, remembering each game's window.
  const fens: string[] = [];
  const windows: Array<{ game: NormalisedGame; start: number; end: number; offset: number }> = [];

  for (const game of selected) {
    const end = Math.min(game.nodes.length, REPORT_BUDGET.maxPliesPerGame);
    const start = Math.min(REPORT_BUDGET.bookPlies, Math.max(0, end - 1));
    if (end - start < 2) continue;

    // One score per position in the window, plus the position after the last
    // move so the final move can be graded.
    const positionCount = end - start + 1;
    if (fens.length + positionCount > REPORT_BUDGET.maxPositions) break;

    windows.push({ game, start, end, offset: fens.length });
    for (let i = start; i < end; i += 1) fens.push(game.nodes[i].fenBefore);
    fens.push(game.nodes[end - 1].fen);
  }

  const scores = await analyzePositions(fens, {
    depth: REPORT_BUDGET.depth,
    threads: REPORT_BUDGET.threads,
    totalTimeoutMs: REPORT_BUDGET.totalTimeoutMs,
  });

  const accuracies: number[] = [];
  const byPhase: Record<Phase, number[]> = { opening: [], middlegame: [], endgame: [] };
  const counts = { blunder: 0, mistake: 0, inaccuracy: 0 };
  const blunders: Array<{ analysis: MoveAnalysis; node: PositionNode; reply: ServerScore | undefined }> = [];
  const openings = new Map<string, { count: number; wins: number; accuracies: number[] }>();

  let gamesAnalyzed = 0;
  let movesAnalyzed = 0;

  for (const window of windows) {
    const positionCount = window.end - window.start + 1;
    const windowScores = scores.slice(window.offset, window.offset + positionCount);
    // The budget may have cut this game short.
    if (windowScores.length < 2) continue;

    const subNodes = window.game.nodes.slice(
      window.start,
      window.start + windowScores.length - 1,
    );
    const analyses = buildMoveAnalyses(subNodes, windowScores);
    const nodeByPly = new Map(subNodes.map((node) => [node.ply, node]));
    const basePly = subNodes[0].ply;

    const own = analyses.filter(
      (analysis) => nodeByPly.get(analysis.ply)?.mover === window.game.subject,
    );
    if (own.length === 0) continue;

    gamesAnalyzed += 1;
    movesAnalyzed += own.length;

    const gameAccuracies: number[] = [];
    for (const analysis of own) {
      const node = nodeByPly.get(analysis.ply);
      if (!node) continue;

      accuracies.push(analysis.accuracy);
      gameAccuracies.push(analysis.accuracy);
      byPhase[phaseFor(node.fenBefore, node.ply)].push(analysis.accuracy);

      if (analysis.classification === "blunder") {
        counts.blunder += 1;
        // windowScores[i] scores the position before subNodes[i], so the score
        // just after this move — the engine's refutation — sits at i + 1.
        const reply = windowScores[analysis.ply - basePly + 1];
        blunders.push({ analysis, node, reply });
      } else if (analysis.classification === "mistake") {
        counts.mistake += 1;
      } else if (analysis.classification === "inaccuracy") {
        counts.inaccuracy += 1;
      }
    }

    const opening = openings.get(window.game.openingName) ?? {
      count: 0,
      wins: 0,
      accuracies: [],
    };
    opening.count += 1;
    opening.wins += window.game.won ? 1 : 0;
    opening.accuracies.push(...gameAccuracies);
    openings.set(window.game.openingName, opening);
  }

  const entries = [...openings.entries()];
  const rate = (value: number) =>
    movesAnalyzed > 0 ? Math.round((value / movesAnalyzed) * 1000) / 10 : 0;

  const stats: GameReportStats = {
    username,
    totalGames: gamesAnalyzed,
    movesAnalyzed,
    overallAccuracy: averageAccuracy(accuracies),
    blunderRate: rate(counts.blunder),
    mistakeRate: rate(counts.mistake),
    inaccuracyRate: rate(counts.inaccuracy),
    openingAccuracy: averageAccuracy(byPhase.opening),
    middlegameAccuracy: averageAccuracy(byPhase.middlegame),
    endgameAccuracy: averageAccuracy(byPhase.endgame),
    topOpenings: entries
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 3)
      .map(([name, data]) => ({
        name,
        count: data.count,
        winRate: data.count > 0 ? Math.round((data.wins / data.count) * 1000) / 10 : 0,
      })),
    weakestOpenings: entries
      .filter(([, data]) => data.accuracies.length > 0)
      .map(([name, data]) => ({ name, accuracy: averageAccuracy(data.accuracies) }))
      .sort((a, b) => a.accuracy - b.accuracy)
      .slice(0, 3),
    tacticalPatternsMissed: detectPatterns(blunders),
  };

  return { stats, gamesAnalyzed };
}
