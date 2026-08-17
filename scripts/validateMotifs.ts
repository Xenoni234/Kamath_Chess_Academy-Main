/**
 * Score the motif detector against Lichess's own puzzle labels.
 *
 * This is the acceptance test for the tactical profile, and it exists because a
 * hand-rolled motif detector is exactly the kind of code that feels right and is
 * quietly wrong. The `Puzzle` table holds ~500k rows of (fen, solution UCI,
 * themes[]) where `themes` are Lichess's labels — a ready-made ground truth.
 *
 * Precision is the number that matters here. A dossier claiming "they miss forks
 * 40% of the time" is worse than useless if a third of those were not forks, so
 * any motif that cannot clear the bar does not ship. Recall matters less: an
 * under-counted motif understates a weakness, which is the safe direction to be
 * wrong for tournament preparation.
 *
 * Run:  npx tsx --env-file=.env.local scripts/validateMotifs.ts [samplePerMotif]
 */
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { MOTIFS, detectMotifsAcrossLine, type Motif } from "../src/lib/tactics/motifs";

/** Ship nothing below this measured precision. */
const PRECISION_BAR = 0.85;

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

type Counts = { tp: number; fp: number; fn: number; tn: number };

function wilsonLower(successes: number, total: number): number {
  if (total === 0) return 0;
  const z = 1.96;
  const p = successes / total;
  const denom = 1 + (z * z) / total;
  const centre = p + (z * z) / (2 * total);
  const margin = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * total)) / total);
  return Math.max(0, (centre - margin) / denom);
}

async function main() {
  const perMotif = Number(process.argv[2] ?? 2000);
  console.log(`Sampling up to ${perMotif} positive + ${perMotif} negative puzzles per motif.\n`);

  const counts = new Map<Motif, Counts>(
    MOTIFS.map((m) => [m, { tp: 0, fp: 0, fn: 0, tn: 0 }] as const),
  );

  for (const motif of MOTIFS) {
    // Positives: puzzles Lichess labelled with this motif.
    const positives = await db.puzzle.findMany({
      where: { themes: { has: motif } },
      select: { fen: true, moves: true },
      take: perMotif,
    });

    // Negatives: puzzles Lichess did NOT label with it. Without these, precision
    // cannot be measured at all — only recall.
    const negatives = await db.puzzle.findMany({
      where: { NOT: { themes: { has: motif } } },
      select: { fen: true, moves: true },
      take: perMotif,
    });

    const c = counts.get(motif)!;

    for (const puzzle of positives) {
      const detected = detectMotifsAcrossLine(puzzle.fen, puzzle.moves.split(/\s+/).filter(Boolean));
      if (detected.has(motif)) c.tp += 1;
      else c.fn += 1;
    }
    for (const puzzle of negatives) {
      const detected = detectMotifsAcrossLine(puzzle.fen, puzzle.moves.split(/\s+/).filter(Boolean));
      if (detected.has(motif)) c.fp += 1;
      else c.tn += 1;
    }

    process.stdout.write(`  scored ${motif} (${positives.length} pos / ${negatives.length} neg)\n`);
  }

  console.log("\nmotif             n(pos)  n(neg)   precision  recall    F1     verdict");
  console.log("─".repeat(78));

  const shippable: Motif[] = [];
  for (const motif of MOTIFS) {
    const { tp, fp, fn, tn } = counts.get(motif)!;
    const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
    const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
    const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
    // Judge on the lower confidence bound, not the point estimate — a motif
    // measured on few samples should not pass on a lucky run.
    const lower = wilsonLower(tp, tp + fp);
    const ok = lower >= PRECISION_BAR;
    if (ok) shippable.push(motif);
    console.log(
      `${motif.padEnd(18)}${String(tp + fn).padStart(6)}${String(fp + tn).padStart(8)}` +
        `${(precision * 100).toFixed(1).padStart(11)}%${(recall * 100).toFixed(1).padStart(8)}%` +
        `${(f1 * 100).toFixed(1).padStart(7)}%   ${ok ? "SHIP" : `hold (lower bound ${(lower * 100).toFixed(1)}%)`}`,
    );
  }

  console.log(
    `\nBar: ${(PRECISION_BAR * 100).toFixed(0)}% precision at the 95% lower bound.` +
      `\nShippable: ${shippable.length ? shippable.join(", ") : "none"}`,
  );

  await db.$disconnect();
}

main().catch(async (error) => {
  console.error(error);
  await db.$disconnect();
  process.exit(1);
});
