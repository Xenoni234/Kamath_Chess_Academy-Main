/**
 * Move quality maths, shared by the analysis board and the report generator so
 * the two never disagree.
 *
 * The win-percentage and accuracy curves are Lichess's, which means a KCA
 * accuracy figure is directly comparable to the one Lichess shows for the same
 * game — useful for sanity-checking the engine pipeline.
 * https://lichess.org/page/accuracy
 */

/** Mate is treated as a decisive but finite score so the curves stay bounded. */
const MATE_CP = 10000;

export type MoveClassification =
  | "best"
  | "excellent"
  | "good"
  | "inaccuracy"
  | "mistake"
  | "blunder";

/**
 * Expected score (0-100) for the side the centipawn value favours.
 * `cp` must already be from the point of view you want the answer for.
 */
export function winPercent(cp: number): number {
  const clamped = Math.max(-MATE_CP, Math.min(MATE_CP, cp));
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * clamped)) - 1);
}

/** Win percentage from a raw engine score, for the given point of view. */
export function winPercentFromScore(cp: number | null, mate: number | null): number {
  if (mate !== null) {
    return mate > 0 ? 100 : 0;
  }
  return winPercent(cp ?? 0);
}

/**
 * Per-move accuracy (0-100) from the drop in win percentage caused by the move.
 * Both arguments must be from the *mover's* point of view.
 */
export function moveAccuracy(winBefore: number, winAfter: number): number {
  const drop = Math.max(0, winBefore - winAfter);
  const raw = 103.1668 * Math.exp(-0.04354 * drop) - 3.1669;
  return Math.max(0, Math.min(100, raw));
}

/**
 * Centipawn loss from the mover's point of view: how much worse the position
 * became compared with playing the engine's choice. Inputs are White-POV.
 */
export function centipawnLoss(
  evalBeforeWhitePov: number,
  evalAfterWhitePov: number,
  mover: "w" | "b",
): number {
  const before = mover === "w" ? evalBeforeWhitePov : -evalBeforeWhitePov;
  const after = mover === "w" ? evalAfterWhitePov : -evalAfterWhitePov;
  return Math.max(0, before - after);
}

/**
 * Convert a score pair to a single centipawn number usable in the curves above.
 * A forced mate collapses to a large finite value scaled by distance, so mate
 * in 1 outranks mate in 8.
 */
export function scoreToCentipawns(cp: number | null, mate: number | null): number {
  if (mate !== null) {
    if (mate === 0) return 0;
    const magnitude = MATE_CP - Math.min(Math.abs(mate), 40) * 100;
    return mate > 0 ? magnitude : -magnitude;
  }
  return cp ?? 0;
}

export function classifyMove(params: {
  cpLoss: number;
  /** True when the move played was the engine's top choice. */
  isTopMove: boolean;
}): MoveClassification {
  if (params.isTopMove) return "best";
  if (params.cpLoss >= 300) return "blunder";
  if (params.cpLoss >= 100) return "mistake";
  if (params.cpLoss >= 50) return "inaccuracy";
  if (params.cpLoss >= 20) return "good";
  return "excellent";
}

export const CLASSIFICATION_META: Record<
  MoveClassification,
  { label: string; symbol: string; textClass: string; bgClass: string }
> = {
  best: {
    label: "Best",
    symbol: "★",
    textClass: "text-kca-cyan",
    bgClass: "bg-kca-cyan/10 border-kca-cyan/30",
  },
  excellent: {
    label: "Excellent",
    symbol: "!",
    textClass: "text-kca-success",
    bgClass: "bg-kca-success/10 border-kca-success/30",
  },
  good: {
    label: "Good",
    symbol: "",
    textClass: "text-kca-gray-100",
    bgClass: "bg-kca-gray-600/20 border-kca-gray-600/30",
  },
  inaccuracy: {
    label: "Inaccuracy",
    symbol: "?!",
    textClass: "text-kca-warning",
    bgClass: "bg-kca-warning/10 border-kca-warning/30",
  },
  mistake: {
    label: "Mistake",
    symbol: "?",
    textClass: "text-kca-warning",
    bgClass: "bg-kca-warning/15 border-kca-warning/40",
  },
  blunder: {
    label: "Blunder",
    symbol: "??",
    textClass: "text-kca-danger",
    bgClass: "bg-kca-danger/10 border-kca-danger/30",
  },
};

/** Mean of per-move accuracies, rounded to one decimal. 0 when there are none. */
export function averageAccuracy(accuracies: number[]): number {
  if (accuracies.length === 0) return 0;
  const total = accuracies.reduce((sum, value) => sum + value, 0);
  return Math.round((total / accuracies.length) * 10) / 10;
}
