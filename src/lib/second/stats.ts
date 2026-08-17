/**
 * Small statistics helpers shared by the tactical and behavioural profiles.
 *
 * Everything here exists to stop a number being reported without its
 * uncertainty. A dossier is preparation someone takes into a tournament, and a
 * confident-looking rate derived from three observations is worse than no rate
 * at all.
 */

/**
 * 95% Wilson score interval for a proportion.
 *
 * Wilson rather than the normal approximation because the latter misbehaves
 * badly at exactly the sample sizes this pipeline produces — it happily returns
 * intervals below 0 or above 1, and collapses to zero width at p = 0 or 1,
 * which would make "missed 3 of 3" look like certainty.
 */
export function wilson(successes: number, total: number): { low: number; high: number } {
  if (total === 0) return { low: 0, high: 0 };
  const z = 1.96;
  const p = successes / total;
  const denom = 1 + (z * z) / total;
  const centre = p + (z * z) / (2 * total);
  const margin = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * total)) / total);
  return {
    low: Math.max(0, (centre - margin) / denom),
    high: Math.min(1, (centre + margin) / denom),
  };
}

/** Mean with a 95% confidence interval. Returns nulls for an empty sample. */
export function meanWithInterval(values: number[]): {
  mean: number;
  low: number;
  high: number;
} {
  const n = values.length;
  if (n === 0) return { mean: 0, low: 0, high: 0 };
  const mean = values.reduce((sum, v) => sum + v, 0) / n;
  if (n < 2) return { mean, low: mean, high: mean };
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (n - 1);
  const stderr = Math.sqrt(variance / n);
  const margin = 1.96 * stderr;
  return { mean, low: mean - margin, high: mean + margin };
}

/** Median of a numeric sample. Returns null for an empty one. */
export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}
