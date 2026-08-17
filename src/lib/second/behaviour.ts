/**
 * Track F7 — behavioural profiling.
 *
 * "When does this opponent get nervous" is not directly measurable, and this
 * module does not pretend otherwise. What it measures is a set of proxies, each
 * a bucketed accuracy over their own games with the sample size attached:
 *
 *   - accuracy as their clock runs down
 *   - accuracy after a long think versus a normal one
 *   - accuracy in the game right after a loss versus after a win
 *   - accuracy by the character of the position (open/closed, queens, castling)
 *   - how their losses actually end
 *
 * None of this is psychology. It is correlation over the games they played, and
 * the UI says so. Every bucket below `MIN_SAMPLES` is reported as insufficient
 * evidence rather than as a number — with buckets this narrow it is very easy to
 * produce a confident-looking figure from six moves.
 *
 * Costs no engine time: it consumes the same scan the tactical profile uses.
 */
import { Chess } from "chess.js";
import { meanWithInterval, median, wilson } from "@/lib/second/stats";
import type { GradedMove } from "@/lib/second/scan";
import type { BehaviourBucket, BehaviouralProfile, WeightedGame } from "@/lib/second/types";

/** Below this many moves (or games) a bucket reports no figure. */
export const MIN_SAMPLES = 25;
/** Losses needed before the termination breakdown is worth showing. */
const MIN_LOSSES = 8;
/** A move losing at least this much counts as a blunder for the rate. */
const BLUNDER_CP = 300;

function bucketFrom(label: string, moves: GradedMove[]): BehaviourBucket {
  const accuracies = moves.map((m) => m.accuracy);
  const { mean, low, high } = meanWithInterval(accuracies);
  const blunders = moves.filter((m) => m.cpLoss >= BLUNDER_CP).length;
  return {
    label,
    n: moves.length,
    accuracy: mean,
    accuracyLow: Math.max(0, low),
    accuracyHigh: Math.min(100, high),
    blunderRate: moves.length ? blunders / moves.length : 0,
  };
}

/**
 * Coarse description of a position's character.
 *
 * Deliberately crude and explicit rather than clever: each label has to mean one
 * thing a player would recognise, because these become sentences like "they play
 * worse in closed positions". Anything subtler would be unfalsifiable.
 */
function positionTraits(fen: string): string[] {
  const traits: string[] = [];
  let board: Chess;
  try {
    board = new Chess(fen);
  } catch {
    return traits;
  }

  let pawns = 0;
  let queens = 0;
  let whiteKingFile = -1;
  let blackKingFile = -1;
  const files = "abcdefgh";

  for (const row of board.board()) {
    for (const cell of row) {
      if (!cell) continue;
      if (cell.type === "p") pawns += 1;
      if (cell.type === "q") queens += 1;
      if (cell.type === "k") {
        const file = files.indexOf(cell.square[0]);
        if (cell.color === "w") whiteKingFile = file;
        else blackKingFile = file;
      }
    }
  }

  if (pawns >= 14) traits.push("Closed positions");
  else if (pawns <= 8) traits.push("Open positions");

  traits.push(queens === 0 ? "Queenless middlegames" : "Queens on the board");

  // Opposite-side castling: one king on the a-c files, the other on f-h.
  if (whiteKingFile >= 0 && blackKingFile >= 0) {
    const whiteSide = whiteKingFile <= 2 ? "q" : whiteKingFile >= 5 ? "k" : "c";
    const blackSide = blackKingFile <= 2 ? "q" : blackKingFile >= 5 ? "k" : "c";
    if (whiteSide !== "c" && blackSide !== "c" && whiteSide !== blackSide) {
      traits.push("Opposite-side castling");
    }
  }

  return traits;
}

const TERMINATION_LABEL: Record<string, string> = {
  mate: "Checkmated",
  resign: "Resigned",
  flagged: "Lost on time",
  abandoned: "Abandoned the game",
  aborted: "Aborted",
  "rules-infraction": "Rules infraction",
  unknown: "Unrecorded",
};

export function profileBehaviour(
  games: WeightedGame[],
  moves: GradedMove[],
): BehaviouralProfile {
  const clockMoves = moves.filter((m) => m.thinkCs !== null && m.remainingBeforeCs !== null);
  const clockDataAvailable = clockMoves.length >= MIN_SAMPLES;

  // --- Time pressure -------------------------------------------------------
  // Bucketed as a FRACTION of the base clock, never as raw seconds: ten seconds
  // left is a crisis in a 3+2 and routine in a 15+10, and averaging the two
  // describes neither.
  const timePressure: BehaviourBucket[] = [];
  if (clockDataAvailable) {
    const bands: { label: string; min: number; max: number }[] = [
      { label: "Over half their clock left", min: 0.5, max: Infinity },
      { label: "Quarter to half left", min: 0.25, max: 0.5 },
      { label: "Tenth to a quarter left", min: 0.1, max: 0.25 },
      { label: "Under a tenth left", min: 0, max: 0.1 },
    ];
    const withFraction = clockMoves
      .map((m) => {
        const game = games[m.gameIndex];
        const initial = game?.timeControl.initialSec;
        if (!initial) return null;
        return { move: m, fraction: (m.remainingBeforeCs as number) / (initial * 100) };
      })
      .filter((x): x is { move: GradedMove; fraction: number } => x !== null);

    for (const band of bands) {
      const inBand = withFraction
        .filter((x) => x.fraction >= band.min && x.fraction < band.max)
        .map((x) => x.move);
      if (inBand.length > 0) timePressure.push(bucketFrom(band.label, inBand));
    }
  }

  // --- Long thinks ---------------------------------------------------------
  // A long think that still goes wrong is the strongest available signal that a
  // position type genuinely confuses them, as opposed to a careless slip.
  const longThink: BehaviourBucket[] = [];
  if (clockDataAvailable) {
    const med = median(clockMoves.map((m) => m.thinkCs as number));
    if (med !== null && med > 0) {
      const long = clockMoves.filter((m) => (m.thinkCs as number) >= med * 3);
      const normal = clockMoves.filter((m) => (m.thinkCs as number) < med * 3);
      if (normal.length > 0) longThink.push(bucketFrom("Normal thinking time", normal));
      if (long.length > 0) longThink.push(bucketFrom("After a long think", long));
    }
  }

  // --- Tilt ----------------------------------------------------------------
  // Games ordered by when they ENDED, per account: "the game after a loss" only
  // means anything within one account's own sequence.
  const tilt: BehaviourBucket[] = [];
  const order = games
    .map((game, index) => ({ game, index }))
    .sort((a, b) => a.game.playedAt.getTime() - b.game.playedAt.getTime());
  const previousResult = new Map<number, "win" | "loss" | "draw">();
  const lastByAccount = new Map<string, "win" | "loss" | "draw">();
  for (const { game, index } of order) {
    const key = `${game.account.source}:${game.account.handle.toLowerCase()}`;
    const previous = lastByAccount.get(key);
    if (previous) previousResult.set(index, previous);
    lastByAccount.set(key, game.won ? "win" : game.drawn ? "draw" : "loss");
  }
  const afterLoss = moves.filter((m) => previousResult.get(m.gameIndex) === "loss");
  const afterWin = moves.filter((m) => previousResult.get(m.gameIndex) === "win");
  if (afterWin.length > 0) tilt.push(bucketFrom("In the game after a win", afterWin));
  if (afterLoss.length > 0) tilt.push(bucketFrom("In the game after a loss", afterLoss));

  // --- Position character --------------------------------------------------
  const byTrait = new Map<string, GradedMove[]>();
  for (const move of moves) {
    for (const trait of positionTraits(move.fenBefore)) {
      const list = byTrait.get(trait) ?? [];
      list.push(move);
      byTrait.set(trait, list);
    }
  }
  const structures = [...byTrait.entries()]
    .map(([label, list]) => bucketFrom(label, list))
    .sort((a, b) => a.accuracy - b.accuracy);

  // --- How their losses end ------------------------------------------------
  const losses = games.filter((g) => !g.won && !g.drawn);
  const terminationCounts = new Map<string, number>();
  for (const loss of losses) {
    terminationCounts.set(loss.termination, (terminationCounts.get(loss.termination) ?? 0) + 1);
  }
  const terminations =
    losses.length >= MIN_LOSSES
      ? [...terminationCounts.entries()]
          .map(([termination, count]) => {
            const interval = wilson(count, losses.length);
            return {
              termination,
              label: TERMINATION_LABEL[termination] ?? termination,
              count,
              share: count / losses.length,
              shareLow: interval.low,
              shareHigh: interval.high,
            };
          })
          .sort((a, b) => b.count - a.count)
      : [];

  return {
    gamesScanned: games.length,
    movesGraded: moves.length,
    minSamples: MIN_SAMPLES,
    clockDataAvailable,
    timePressure,
    longThink,
    tilt,
    structures,
    lossesAnalyzed: losses.length,
    terminations,
  };
}
