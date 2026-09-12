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
import { averageAccuracy, centipawnLoss, classifyMove, scoreToCentipawns } from "@/lib/engine/classify";
import type { GameReportStats } from "@/lib/claude";

/**
 * Budget.
 *
 * `maxGames` was 20, which is why a student with 70 games in four days got a report
 * covering 19 of them and a "Most played openings" table where every row said "1 game".
 * A report built from one game per opening cannot tell anyone anything: a 0% win rate
 * over a single game is noise being printed as a finding.
 *
 * MEASURED, not estimated (scripts/measureReportBudget.ts): depth 12 costs **23 ms per
 * position** on one engine with threads 2. Note `analyzePositions` is deliberately serial
 * on a SINGLE engine — unlike the dossier scan it does not fan out across
 * `ENGINE_CONCURRENCY` — so that figure is the real code path, not a best case. The
 * production box is a 2-vCPU VPS and runs perhaps 5-8x slower per core, which puts
 * 60 games (~2000 positions) at roughly 4-6 minutes of engine time.
 *
 * `totalTimeoutMs` is therefore 15 minutes: well clear of that estimate, because
 * exhausting the budget is SILENT in the only way that matters here — `analyzePositions`
 * returns a short array, the games past the cut are skipped, and the report simply
 * reports fewer games than the student has. Honest, but it is the exact complaint.
 *
 * Raising `maxGames` further means re-measuring on the VPS first. Do not guess it up.
 */
export const REPORT_BUDGET = {
  maxGames: 60,
  depth: 12,
  threads: 2,
  /** Opening moves are book; scoring them punishes theory the player knows. */
  bookPlies: 8,
  /**
   * This, not `maxGames`, is what actually binds. Measured in production: a 60-game
   * request analysed only 36, because these games average ~67 scored positions each and
   * 36 x 67 is the old 2400 ceiling. Raising `maxGames` alone did nothing.
   *
   * More games matters specifically for the OPENING tables — "1 game, 100% win rate" is
   * noise printed as a finding, and that was the original complaint. Accuracy and blunder
   * rate converge long before this.
   */
  maxPositions: 4000,
  maxPliesPerGame: 120,
  totalTimeoutMs: 15 * 60 * 1000,
  /**
   * Depth for the second look at anything the shallow pass called a BLUNDER.
   *
   * Digital Second already refuses to accuse a player on depth 12 alone — "a depth-12
   * best move is not solid enough to accuse someone of missing a tactic" — and re-checks
   * at 18. The report was making a stronger accusation ("this move was a blunder") on
   * weaker evidence, to a child, about their own game.
   *
   * MEASURED: depth 18 costs 196 ms per position against 23 ms at depth 12 — 8.5x. That
   * is why only blunders are re-checked and not mistakes: at the observed rates, blunders
   * cost ~150 extra searches, while including mistakes would cost ~500 and add eight to
   * thirteen minutes to a report that already takes fifteen.
   */
  confirmDepth: 18,
  confirmTimeoutMs: 5 * 60 * 1000,
};

export type NormalisedGame = {
  /** Which colour the report's subject played. */
  subject: "w" | "b";
  nodes: PositionNode[];
  openingName: string;
  won: boolean;
  /**
   * Tracked separately because a draw is NOT a loss. Both normalisers derived
   * `won` alone, so every drawn game was counted as a defeat in the opening
   * tables — a player who draws half their Caro-Kanns was shown a 50% win rate
   * as if they were losing them. The tables now report SCORE (win 1, draw ½).
   */
  drawn: boolean;
};

/**
 * Chess.com's per-player `result` string. Anything not listed here is a loss
 * ("checkmated", "resigned", "timeout", "abandoned"); "win" is the only win.
 */
const CHESSCOM_DRAWS = new Set([
  "agreed",
  "repetition",
  "stalemate",
  "insufficient",
  "50move",
  "timevsinsufficient",
]);

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
      // Lichess omits `winner` entirely on a draw.
      drawn: entry.winner === undefined,
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
      drawn: CHESSCOM_DRAWS.has(player?.result ?? ""),
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
/**
 * Collapse a hyper-specific opening name to its FAMILY.
 *
 * This is the single biggest reason a real report looked wrong. Chess.com and Lichess
 * name openings down to the exact move order, so one student's 36 games scattered across
 * ~30 distinct "openings" and every row of the table read "1 game". Their actual report
 * listed these as three separate openings:
 *
 *   Closed Sicilian Defense Portland Attack 3...g6 4.Be3   1 game   100.0%
 *   Colle System 3...e6 4.Bd3 Bd6 5.Nbd2                   1 game     0.0%
 *   Colle System Rubinstein Opening 5...Nc6 6.O O          1 game     0.0%
 *
 * — two of which are the same opening, and none of which support a percentage. The
 * narrative then told a child they had "a 100% win rate in the Closed Sicilian", from one
 * game.
 *
 * The rule: drop the trailing move list, take the part before Lichess's ":", then cut at
 * the first family word (Defense / Opening / Game / System / Gambit / Attack) or three
 * words, whichever comes first. Deliberately blunt — grouping slightly too broadly pools
 * evidence, while grouping too narrowly manufactures 1-game findings, and only one of
 * those two failures misleads a student.
 */
const FAMILY_WORDS = /^(defense|defence|opening|game|system|gambit|attack)$/i;

export function openingFamily(name: string): string {
  // Everything from the first move-number token onwards is a move list, not a name.
  // `^` as well as `\s`, because a name that is ONLY a move list ("1.e4 e5") has no
  // leading space and would otherwise survive whole.
  const withoutMoves = name.split(/(?:^|\s+)\d+\.{1,3}/)[0] ?? name;
  // Lichess writes "Family: Variation, Sub-variation".
  const beforeColon = (withoutMoves.split(":")[0] ?? withoutMoves).split(",")[0] ?? withoutMoves;

  const words = beforeColon.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "Unknown Opening";

  const out: string[] = [];
  for (const word of words) {
    out.push(word);
    if (FAMILY_WORDS.test(word)) break;
    if (out.length === 3) break;
  }

  // A leftover digit means this was notation, not a name. Better to say "Unknown Opening"
  // than to open a table row with "2.Nf3" and call it an opening the student plays.
  const family = out.join(" ");
  return family && !/\d/.test(family) ? family : "Unknown Opening";
}

/**
 * Below this many games an opening gets a name and a count but NO percentage.
 *
 * The same rule the dossier already applies to every rate it publishes: a figure computed
 * from one or two events is not a finding, and printing it as one is how a report becomes
 * superstition. Three is the floor at which "you tend to..." is worth saying at all.
 */
export const MIN_OPENING_GAMES = 3;

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

/** A blunder the shallow pass flagged, with everything needed to re-judge it. */
type BlunderCandidate = {
  analysis: MoveAnalysis;
  node: PositionNode;
  mover: "w" | "b";
};

/**
 * Re-judge the shallow pass's blunders at `confirmDepth`, and return the plies that
 * survive.
 *
 * Depth 12 sees a move as throwing away three pawns; depth 18 often sees the compensation
 * and the "blunder" evaporates. Publishing the shallow verdict means telling a student
 * they blundered when they did not — which is both wrong and, for a child reading a report
 * about their own play, worse than wrong.
 *
 * When the budget runs out the remaining candidates KEEP their shallow verdict rather than
 * being dropped. Dropping would bias the blunder rate downward by silently deleting the
 * very moves under examination; `confirmed` reports how many were actually re-checked so
 * the caller can be honest about it.
 */
async function confirmBlunders(
  candidates: BlunderCandidate[],
): Promise<{ survivors: Set<number>; confirmed: number }> {
  // Keyed by INDEX into `candidates`, never by ply: ply restarts in every game, so a
  // surviving blunder on move 15 of one game would otherwise vouch for move 15 of every
  // other game in the report.
  const survivors = new Set(candidates.map((_, index) => index));
  if (candidates.length === 0) return { survivors, confirmed: 0 };

  const fens: string[] = [];
  for (const c of candidates) {
    fens.push(c.node.fenBefore, c.node.fen);
  }

  const deep = await analyzePositions(fens, {
    depth: REPORT_BUDGET.confirmDepth,
    threads: REPORT_BUDGET.threads,
    totalTimeoutMs: REPORT_BUDGET.confirmTimeoutMs,
  });

  let confirmed = 0;
  for (let i = 0; i < candidates.length; i += 1) {
    const before = deep[i * 2];
    const after = deep[i * 2 + 1];
    // A short array means the budget ran out here; everything past this point keeps its
    // shallow verdict.
    if (!before || !after) break;

    confirmed += 1;
    const cpLoss = centipawnLoss(
      scoreToCentipawns(before.cp, before.mate),
      scoreToCentipawns(after.cp, after.mate),
      candidates[i].mover,
    );
    if (classifyMove({ cpLoss, isTopMove: false }) !== "blunder") {
      survivors.delete(i);
    }
  }

  if (confirmed < candidates.length) {
    console.warn(
      `[report] deep confirmation ran out after ${confirmed}/${candidates.length} blunders`,
    );
  }
  return { survivors, confirmed };
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
  const candidates: BlunderCandidate[] = [];
  const openings = new Map<string, { count: number; score: number; accuracies: number[] }>();

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
        // NOT counted yet — a depth-12 blunder is a candidate, not a verdict. The deep
        // pass below decides, and `counts.blunder` is tallied from what survives.
        // windowScores[i] scores the position before subNodes[i], so the score
        // just after this move — the engine's refutation — sits at i + 1.
        const reply = windowScores[analysis.ply - basePly + 1];
        blunders.push({ analysis, node, reply });
        candidates.push({ analysis, node, mover: window.game.subject });
      } else if (analysis.classification === "mistake") {
        counts.mistake += 1;
      } else if (analysis.classification === "inaccuracy") {
        counts.inaccuracy += 1;
      }
    }

    // Keyed by FAMILY, so move-order variants of one opening pool their evidence
    // instead of each producing its own single-game row.
    const family = openingFamily(window.game.openingName);
    const opening = openings.get(family) ?? { count: 0, score: 0, accuracies: [] };
    opening.count += 1;
    // Score, not wins: a draw is half a point, not a loss.
    opening.score += window.game.won ? 1 : window.game.drawn ? 0.5 : 0;
    opening.accuracies.push(...gameAccuracies);
    openings.set(family, opening);
  }

  // Second look at every shallow blunder. Only the ones that survive depth 18 are counted
  // or shown, so the blunder rate and the "recurring problems" list describe moves that
  // are still blunders when the engine looks properly.
  const { survivors, confirmed } = await confirmBlunders(candidates);
  // `blunders` and `candidates` are appended together in the same loop, so index i in one
  // is index i in the other. Filtering both by the same index set keeps them aligned.
  counts.blunder = survivors.size;
  const confirmedBlunders = blunders.filter((_, index) => survivors.has(index));
  if (confirmed < candidates.length) {
    console.warn(
      `[report] ${candidates.length - confirmed} blunders kept their depth-12 verdict`,
    );
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
    // Only openings with enough games carry a percentage. Below the floor the row still
    // appears — the student DID play it — but `winRate` is null and the renderer and the
    // prompt both say "not enough games yet" rather than printing a number.
    topOpenings: entries
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 5)
      .map(([name, data]) => ({
        name,
        count: data.count,
        winRate:
          data.count >= MIN_OPENING_GAMES
            ? Math.round((data.score / data.count) * 1000) / 10
            : null,
      })),
    weakestOpenings: entries
      .filter(([, data]) => data.count >= MIN_OPENING_GAMES && data.accuracies.length > 0)
      .map(([name, data]) => ({
        name,
        accuracy: averageAccuracy(data.accuracies),
        count: data.count,
      }))
      .sort((a, b) => a.accuracy - b.accuracy)
      .slice(0, 3),
    tacticalPatternsMissed: detectPatterns(confirmedBlunders),
  };

  return { stats, gamesAnalyzed };
}
