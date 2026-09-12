/**
 * Profile a student against THEIR OWN games, using the same engine stages as Digital
 * Second.
 *
 * The game report used to be four numbers and a narrative about them. A student asking
 * "what am I actually bad at" got an accuracy percentage, which is a score, not an answer.
 * Everything needed to answer it properly already existed in `src/lib/second/` — it was
 * only ever pointed at opponents.
 *
 * Reuses, unchanged: `fetchOpponentGames` (ingest, with clocks and ratings),
 * `scanGames` (depth 12 then depth 18 where their move differed), `profileTactics`,
 * `profileBehaviour`, `profileEvolution` and `detectWeaknesses`.
 *
 * Three things are deliberately different from the dossier:
 *
 * 1. **BOTH colours.** `scanGames` filters to one colour, which is right for prep — you
 *    play one side against them. It is wrong for self-review: a player's weaknesses as
 *    White and as Black are genuinely different, and reporting only one half while
 *    calling it "your play" would be a lie of omission.
 * 2. **The scan budget is split across the two colours**, so profiling both costs about
 *    what profiling one opponent costs rather than double. `scanGames` slices to its own
 *    budget internally, so pre-slicing the input is enough to control it — no change to
 *    the scan itself.
 * 3. **It never computes headline accuracy.** `ScanResult.moves` DROPS moves that never
 *    got their depth-18 confirmation, and those are precisely the moves that differed
 *    from the engine's choice — the worse ones. An average over what survives is biased
 *    upward. The report's own unbiased pass owns every published figure; this module only
 *    adds the qualitative sections. Do not "simplify" by deriving accuracy here.
 *
 * Every stage degrades to undefined rather than throwing. A failure here costs the
 * student some sections, never the report.
 */
import { fetchOpponentGames } from "@/lib/second/ingest";
import { scanGames, type GradedMove } from "@/lib/second/scan";
import { profileTactics } from "@/lib/second/tactics";
import { profileBehaviour } from "@/lib/second/behaviour";
import { profileEvolution } from "@/lib/second/evolution";
import { detectWeaknesses } from "@/lib/second/weakness";
import { ENGINE_CONCURRENCY } from "@/lib/engine/serverEngine";
import type {
  BehaviouralProfile,
  EvolutionProfile,
  OpponentSource,
  TacticalProfile,
  WeaknessPosition,
  WeightedGame,
} from "@/lib/second/types";

/** One colour's worth of self-profile. */
export type SelfColourProfile = {
  colour: "w" | "b";
  gamesScanned: number;
  /** Moves that never got a depth-18 confirmation, so the evidence is thinner than it looks. */
  unconfirmed: number;
  tactical?: TacticalProfile;
  behaviour?: BehaviouralProfile;
  weaknesses: WeaknessPosition[];
};

export type SelfProfile = {
  /** Present only for the colours the student actually played. */
  colours: SelfColourProfile[];
  /** Across both colours — style over time is not a per-colour question. */
  evolution?: EvolutionProfile;
  gamesIngested: number;
};

/**
 * How many games to scan PER COLOUR.
 *
 * `scanGames` derives its own budget from `ENGINE_CONCURRENCY` (~35 games per engine) and
 * a dossier spends all of it on one colour. Halving it here keeps a two-colour self
 * profile at roughly the cost of a one-colour dossier — measured at ~139 s on the 2-vCPU
 * production box. The floor of 8 exists so a student with few games still gets something
 * rather than an empty section.
 */
function perColourBudget(): number {
  return Math.max(8, Math.floor(Math.max(20, ENGINE_CONCURRENCY * 35) / 2));
}

/** Enough games that both colours have something to scan. */
const INGEST_MAX = 160;

export async function buildSelfProfile(
  handle: string,
  source: OpponentSource,
): Promise<SelfProfile | null> {
  let games: WeightedGame[];
  try {
    const result = await fetchOpponentGames(handle, source, { max: INGEST_MAX });
    games = result.games;
  } catch (error) {
    console.error("[report] self-profile ingest failed:", error);
    return null;
  }

  if (games.length === 0) return null;

  const budget = perColourBudget();
  const colours: SelfColourProfile[] = [];
  const allMoves: GradedMove[] = [];
  const allScanned: WeightedGame[] = [];

  for (const colour of ["w", "b"] as const) {
    // Newest first, then cut to the per-colour budget. `scanGames` slices to its own
    // (larger) budget after this, so this is what actually binds.
    const ofColour = games
      .filter((g) => g.color === colour)
      .sort((a, b) => b.playedAt.getTime() - a.playedAt.getTime())
      .slice(0, budget);

    if (ofColour.length < 3) continue; // too little to say anything honest about

    try {
      const scan = await scanGames(ofColour, colour);
      allMoves.push(...scan.moves);
      allScanned.push(...scan.games);

      // Weaknesses read the games directly rather than the scan, and use their own
      // engine budget, so a scan that came back thin does not silently thin these too.
      let weaknesses: WeaknessPosition[] = [];
      try {
        weaknesses = (await detectWeaknesses(ofColour, colour)).weaknesses;
      } catch (error) {
        console.error(`[report] weakness pass failed for ${colour}:`, error);
      }

      colours.push({
        colour,
        gamesScanned: scan.games.length,
        unconfirmed: scan.unconfirmed,
        tactical: profileTactics(scan.moves, scan.games.length),
        behaviour: profileBehaviour(scan.games, scan.moves),
        weaknesses,
      });
    } catch (error) {
      console.error(`[report] self-profile scan failed for ${colour}:`, error);
    }
  }

  if (colours.length === 0) return null;

  let evolution: EvolutionProfile | undefined;
  try {
    // Same scan records, sliced by era — no extra engine work.
    evolution = profileEvolution(allScanned, allMoves);
  } catch (error) {
    console.error("[report] evolution pass failed:", error);
  }

  return { colours, evolution, gamesIngested: games.length };
}

const COLOUR_NAME = { w: "White", b: "Black" } as const;

/**
 * Turn a self-profile into prompt text for the report narrative.
 *
 * The hedging here is not decoration. It mirrors `describeArtifact`
 * (`src/lib/second/repertoire.ts`) deliberately, because the same two failures apply:
 * a rate quoted without its denominator becomes superstition, and a behavioural
 * correlation stated without the framing line becomes psychology. The audience is a
 * child, which makes both worse, not more forgivable — "you panic in time trouble" is a
 * thing a nine-year-old will believe about themselves.
 */
export function describeSelfProfile(profile: SelfProfile): string {
  const sections: string[] = [];

  for (const c of profile.colours) {
    const name = COLOUR_NAME[c.colour];
    const block: string[] = [`--- As ${name} (${c.gamesScanned} games engine-graded) ---`];

    if (c.weaknesses.length) {
      block.push(
        `Positions they keep reaching and keep misplaying (opening, moves 3-10):`,
        ...c.weaknesses
          .slice(0, 5)
          .map(
            (w) =>
              `- after ${w.line.join(" ")}: they usually play ${w.theirMove} and score ${w.accuracy.toFixed(0)}% accuracy there` +
              (w.avgClockSpent !== null ? `, spending about ${w.avgClockSpent.toFixed(0)}s on it` : ""),
          ),
      );
    }

    const t = c.tactical;
    const motifs = t
      ? t.motifs
          .filter((m) => m.opportunities >= t.minOpportunities)
          .map(
            (m) =>
              `- ${m.motif}: missed ${m.missed} of ${m.opportunities} chances (${(m.missRate * 100).toFixed(0)}%, 95% CI ${(m.missRateLow * 100).toFixed(0)}-${(m.missRateHigh * 100).toFixed(0)}%), spotted ${m.found}.`,
          )
      : [];
    block.push(
      `Tactics as ${name}. Only patterns with enough evidence are listed. Treat a wide interval as "not known yet", never as a finding, and never give a rate without its sample size:`,
      ...(motifs.length ? motifs : ["- not enough evidence yet to name a tactical pattern"]),
    );

    const b = c.behaviour;
    const bucketLine = (x: { label: string; n: number; accuracy: number; blunderRate: number }) =>
      `- ${x.label}: ${x.accuracy.toFixed(1)}% accuracy over ${x.n} moves, ${(x.blunderRate * 100).toFixed(0)}% of them blunders`;
    const behaviour = b
      ? [
          b.clockDataAvailable && b.timePressure.length
            ? `Clock:\n${b.timePressure.filter((x) => x.n >= b.minSamples).map(bucketLine).join("\n")}`
            : "",
          b.clockDataAvailable && b.longThink.length
            ? `Think time:\n${b.longThink.filter((x) => x.n >= b.minSamples).map(bucketLine).join("\n")}`
            : "",
          b.structures.length
            ? `Position type:\n${b.structures.filter((x) => x.n >= b.minSamples).map(bucketLine).join("\n")}`
            : "",
          b.terminations.length
            ? `How their ${b.lossesAnalyzed} losses as ${name} ended:\n${b.terminations.map((x) => `- ${x.label}: ${x.count} (${(x.share * 100).toFixed(0)}%)`).join("\n")}`
            : "",
        ].filter(Boolean)
      : [];
    block.push(
      `Patterns as ${name} (${b?.movesGraded ?? 0} moves). These are CORRELATIONS over their own games, NOT psychology — say what the numbers show and never claim what the student feels, fears or intends:`,
      ...(behaviour.length ? behaviour : ["- not enough evidence yet to name a pattern"]),
    );

    if (c.unconfirmed > 0) {
      block.push(
        `(${c.unconfirmed} of their moves as ${name} could not be double-checked at full depth and were left out, so this section is based on slightly less evidence than the game count suggests.)`,
      );
    }

    sections.push(block.join("\n"));
  }

  const ev = profile.evolution;
  if (ev && !ev.insufficient && ev.eras.length >= 2) {
    sections.push(
      [
        "--- How their play has changed over time (same measurements, sliced by year) ---",
        ...ev.eras.map(
          (e) =>
            `- ${e.label}: ${e.accuracy.toFixed(1)}% accuracy [${e.accuracyLow.toFixed(0)}-${e.accuracyHigh.toFixed(0)}] over ${e.moves} moves, ${(e.blunderRate * 100).toFixed(0)}% blunders${e.meanRating !== null ? `, rated ~${e.meanRating}` : ""}`,
        ),
        ev.trends.length
          ? `Real changes (only stated where the two years' ranges do NOT overlap):\n${ev.trends.map((t) => `- ${t.metric} went ${t.direction} from ${t.from} to ${t.to}: ${t.detail}`).join("\n")}`
          : "No change is big enough to be real yet — the years overlap, so say their level has held rather than inventing a trend.",
      ].join("\n"),
    );
  }

  return sections.join("\n\n");
}
