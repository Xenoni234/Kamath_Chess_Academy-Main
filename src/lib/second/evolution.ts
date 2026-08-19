/**
 * Track F4 — how the opponent's play has changed over time.
 *
 * Every input already exists: each scanned game carries `playedAt` and (for OTB)
 * a per-game rating, and each graded move carries accuracy and cpLoss. This
 * module buckets the SAME games by calendar-year era and recomputes the SAME
 * metrics per era — nothing new is measured, it is only sliced by time.
 *
 * The discipline that makes it trustworthy: a trend is stated ONLY when the two
 * eras' confidence intervals do not overlap. 88% ± 4 in 2023 and 91% ± 5 in 2024
 * is not improvement, and must never be described as any — that is exactly the
 * kind of false, checkable claim that would let a stronger opponent dismiss the
 * whole dossier. We report that the play changed; we never claim to know why.
 */
import { meanWithInterval, wilson } from "@/lib/second/stats";
import type { GradedMove } from "@/lib/second/scan";
import type {
  EvolutionEra,
  EvolutionProfile,
  EvolutionTrend,
  RepertoireShift,
  WeightedGame,
} from "@/lib/second/types";

/** A move losing at least this much counts as a blunder — same bar as behaviour.ts. */
const BLUNDER_CP = 300;

/** An era needs at least this many graded moves before any figure is shown. */
const MIN_ERA_MOVES = 25;
/** ...and at least this many games, so one long game cannot make an era. */
const MIN_ERA_GAMES = 8;

/** A repertoire line must reach this share of an era's games as one colour to
 *  count as part of the repertoire there — below it is a one-off, not a choice. */
const REPERTOIRE_SHARE = 0.15;
/** ...and effectively absent below this, so "abandoned" means gone, not rarer. */
const ABSENT_SHARE = 0.04;
/** A line needs this many games in its prominent era, so "adopted the Benoni"
 *  never rests on two blitz games. */
const MIN_LINE_GAMES = 3;

/** Family, not variation: "Philidor Defense: Lion" and "Philidor Defense: Hanham"
 *  are the same repertoire decision. Group on the part before the colon. */
function openingFamily(name: string): string {
  const head = name.split(":")[0]?.trim();
  return head && head.toLowerCase() !== "unknown opening" ? head : "Other/unclassified";
}

function eraLabelOf(playedAt: Date): string {
  return String(playedAt.getUTCFullYear());
}

/** Per-colour opening-family shares within one era's games. */
function repertoireShares(games: WeightedGame[], color: "w" | "b"): Map<string, { share: number; games: number }> {
  const mine = games.filter((g) => g.color === color);
  const counts = new Map<string, number>();
  for (const g of mine) {
    const family = openingFamily(g.openingName);
    counts.set(family, (counts.get(family) ?? 0) + 1);
  }
  const out = new Map<string, { share: number; games: number }>();
  for (const [family, n] of counts) out.set(family, { share: mine.length ? n / mine.length : 0, games: n });
  return out;
}

/**
 * Build the evolution profile. `games` and `moves` must be the scan's own arrays
 * — `move.gameIndex` indexes straight into `games`.
 */
export function profileEvolution(games: WeightedGame[], moves: GradedMove[]): EvolutionProfile {
  // Group games and their moves by era.
  const movesByGame = new Map<number, GradedMove[]>();
  for (const m of moves) {
    const list = movesByGame.get(m.gameIndex);
    if (list) list.push(m);
    else movesByGame.set(m.gameIndex, [m]);
  }

  type Group = { games: WeightedGame[]; moves: GradedMove[] };
  const byEra = new Map<string, Group>();
  games.forEach((g, index) => {
    const label = eraLabelOf(g.playedAt);
    const group = byEra.get(label) ?? { games: [], moves: [] };
    group.games.push(g);
    group.moves.push(...(movesByGame.get(index) ?? []));
    byEra.set(label, group);
  });

  // Qualifying eras, chronological.
  const eras: EvolutionEra[] = [];
  const qualifyingGroups = new Map<string, Group>();
  for (const label of [...byEra.keys()].sort()) {
    const group = byEra.get(label)!;
    if (group.moves.length < MIN_ERA_MOVES || group.games.length < MIN_ERA_GAMES) continue;
    qualifyingGroups.set(label, group);

    const acc = meanWithInterval(group.moves.map((m) => m.accuracy));
    const blunders = group.moves.filter((m) => m.cpLoss >= BLUNDER_CP).length;
    const blunder = wilson(blunders, group.moves.length);
    const ratings = group.games.map((g) => g.playerRating).filter((r): r is number => r !== null);
    const wins = group.games.filter((g) => g.won).length;
    const draws = group.games.filter((g) => g.drawn).length;

    eras.push({
      label,
      games: group.games.length,
      moves: group.moves.length,
      scorePct: group.games.length ? ((wins + draws / 2) / group.games.length) * 100 : null,
      meanRating: ratings.length ? Math.round(ratings.reduce((s, r) => s + r, 0) / ratings.length) : null,
      accuracy: acc.mean,
      accuracyLow: Math.max(0, acc.low),
      accuracyHigh: Math.min(100, acc.high),
      blunderRate: group.moves.length ? blunders / group.moves.length : 0,
      blunderRateLow: blunder.low,
      blunderRateHigh: blunder.high,
    });
  }

  if (eras.length < 2) {
    return { eras, trends: [], repertoireShifts: [], insufficient: true };
  }

  const first = eras[0];
  const last = eras[eras.length - 1];
  const trends: EvolutionTrend[] = [];

  // Accuracy — intervals on the MEAN must be disjoint.
  if (last.accuracyLow > first.accuracyHigh) {
    trends.push({
      metric: "accuracy",
      direction: "up",
      from: first.label,
      to: last.label,
      detail: `accuracy rose from ${first.accuracy.toFixed(1)}% (${first.label}) to ${last.accuracy.toFixed(1)}% (${last.label})`,
    });
  } else if (last.accuracyHigh < first.accuracyLow) {
    trends.push({
      metric: "accuracy",
      direction: "down",
      from: first.label,
      to: last.label,
      detail: `accuracy fell from ${first.accuracy.toFixed(1)}% (${first.label}) to ${last.accuracy.toFixed(1)}% (${last.label})`,
    });
  }

  // Blunder rate — Wilson intervals must be disjoint. "down" is the good one.
  if (last.blunderRateHigh < first.blunderRateLow) {
    trends.push({
      metric: "blunderRate",
      direction: "down",
      from: first.label,
      to: last.label,
      detail: `blunder rate fell from ${(first.blunderRate * 100).toFixed(0)}% (${first.label}) to ${(last.blunderRate * 100).toFixed(0)}% (${last.label})`,
    });
  } else if (last.blunderRateLow > first.blunderRateHigh) {
    trends.push({
      metric: "blunderRate",
      direction: "up",
      from: first.label,
      to: last.label,
      detail: `blunder rate rose from ${(first.blunderRate * 100).toFixed(0)}% (${first.label}) to ${(last.blunderRate * 100).toFixed(0)}% (${last.label})`,
    });
  }

  // Rating — no interval here, so require a clear gap rather than any drift.
  if (first.meanRating !== null && last.meanRating !== null) {
    const delta = last.meanRating - first.meanRating;
    if (Math.abs(delta) >= 50) {
      trends.push({
        metric: "rating",
        direction: delta > 0 ? "up" : "down",
        from: first.label,
        to: last.label,
        detail: `rating moved from ${first.meanRating} (${first.label}) to ${last.meanRating} (${last.label})`,
      });
    }
  }

  // Repertoire shifts between the first and last qualifying era, per colour.
  const repertoireShifts: RepertoireShift[] = [];
  const firstGroup = qualifyingGroups.get(first.label)!;
  const lastGroup = qualifyingGroups.get(last.label)!;
  for (const color of ["w", "b"] as const) {
    const before = repertoireShares(firstGroup.games, color);
    const after = repertoireShares(lastGroup.games, color);
    const families = new Set([...before.keys(), ...after.keys()]);
    for (const family of families) {
      if (family === "Other/unclassified") continue;
      const b = before.get(family) ?? { share: 0, games: 0 };
      const a = after.get(family) ?? { share: 0, games: 0 };
      if (b.share >= REPERTOIRE_SHARE && a.share <= ABSENT_SHARE && b.games >= MIN_LINE_GAMES) {
        repertoireShifts.push({ color, opening: family, fromShare: b.share, toShare: a.share, direction: "abandoned" });
      } else if (a.share >= REPERTOIRE_SHARE && b.share <= ABSENT_SHARE && a.games >= MIN_LINE_GAMES) {
        repertoireShifts.push({ color, opening: family, fromShare: b.share, toShare: a.share, direction: "adopted" });
      }
    }
  }
  repertoireShifts.sort((x, y) => Math.max(y.fromShare, y.toShare) - Math.max(x.fromShare, x.toShare));

  return { eras, trends, repertoireShifts, insufficient: false };
}
