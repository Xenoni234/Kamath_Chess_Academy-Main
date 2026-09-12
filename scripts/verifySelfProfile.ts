/**
 * The report's self-profile must be honest about how much evidence it has.
 *
 *   npx tsx scripts/verifySelfProfile.ts        # offline: no engine, no network, no DB
 *
 * `describeSelfProfile` is the text the AI narrative is built from, so anything it states
 * without a caveat becomes a claim in a report a nine-year-old reads about themselves.
 * Two failure modes matter more than the formatting:
 *
 *   - a rate quoted without its denominator ("you miss 67% of forks") is how a figure
 *     computed from three events becomes something a child believes about themselves;
 *   - a clock correlation stated as a feeling ("you panic in time trouble") is psychology
 *     the data cannot support.
 *
 * Both are asserted below, along with the thin-evidence caveat and the both-colours rule
 * — reporting only White while calling it "your play" would be a lie of omission.
 */
import { describeSelfProfile, type SelfProfile } from "../src/lib/reports/selfProfile.ts";
import type { BehaviouralProfile, TacticalProfile, WeaknessPosition } from "../src/lib/second/types.ts";

let pass = 0;
let fail = 0;
function check(label: string, ok: boolean, detail = "") {
  if (ok) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}\n        ${detail}`); }
}

const tactical = (found: number, missed: number, opportunities: number): TacticalProfile => ({
  gamesScanned: 17,
  positionsScanned: 540,
  minOpportunities: 5,
  motifs: [
    {
      motif: "fork", opportunities, missed, found,
      missRate: missed / opportunities, missRateLow: 0.31, missRateHigh: 0.78,
      detectorPrecision: 0.903,
    },
  ] as TacticalProfile["motifs"],
});

const behaviour = (): BehaviouralProfile => ({
  gamesScanned: 17, movesGraded: 540, minSamples: 20, clockDataAvailable: true,
  timePressure: [
    { label: "under 10% of clock left", n: 64, accuracy: 71.2, blunderRate: 0.14 },
    { label: "plenty of clock", n: 310, accuracy: 88.9, blunderRate: 0.03 },
    { label: "tiny sample", n: 4, accuracy: 99.9, blunderRate: 0 },
  ] as BehaviouralProfile["timePressure"],
  longThink: [], tilt: [], structures: [],
  lossesAnalyzed: 6, otbLossesExcluded: 0,
  terminations: [{ termination: "resign", label: "resigned", count: 4, share: 0.66, shareLow: 0.3, shareHigh: 0.9 }],
});

const weakness = (): WeaknessPosition => ({
  fen: "r1bqkbnr/pppp1ppp/2n5/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 3",
  line: ["e4", "e5", "Nf3", "Nc6", "Bb5"],
  theirMove: "a6", accuracy: 54.2, avgClockSpent: 31, weightedFrequency: 9, weaknessScore: 0.8,
});

const full: SelfProfile = {
  gamesIngested: 70,
  colours: [
    { colour: "w", gamesScanned: 17, unconfirmed: 0, tactical: tactical(2, 6, 9), behaviour: behaviour(), weaknesses: [weakness()] },
    { colour: "b", gamesScanned: 15, unconfirmed: 23, tactical: tactical(1, 2, 3), behaviour: behaviour(), weaknesses: [] },
  ],
};
const text = describeSelfProfile(full);

console.log("1. Both colours are profiled — one alone is not 'your play'");
check("White has its own section", text.includes("As White"), text.slice(0, 120));
check("Black has its own section", text.includes("As Black"));
check("the two are not merged into one figure", text.indexOf("As White") !== text.indexOf("As Black"));

console.log("2. Every rate carries its denominator");
check("the fork rate names the sample", text.includes("missed 6 of 9 chances"), text);
check("the confidence interval is shown", text.includes("95% CI"), text);
check("clock buckets carry n", text.includes("over 64 moves"), text);
check("losses carry their count", text.includes("resigned: 4"), text);

console.log("3. A sample too small to mean anything never becomes a claim");
check("the n=4 bucket is withheld", !text.includes("99.9"), text);
check("the 3-opportunity motif is withheld as Black", (text.match(/missed 2 of 3/g) ?? []).length === 0, text);

console.log("4. Thin evidence is stated, not hidden");
check("the unconfirmed moves are declared", text.includes("23 of their moves as Black"), text);
check("and explained as less evidence", text.includes("less evidence"), text);

console.log("5. Correlations are never framed as feelings");
check("the prompt forbids psychology explicitly", text.includes("NOT psychology"), text);
check("and forbids claiming what they feel", /never claim what the student feels/.test(text), text);
check("tactics carry the not-known-yet instruction", text.includes('"not known yet"'), text);

console.log("6. Weakness lines are concrete enough to act on");
check("the move order is named", text.includes("e4 e5 Nf3 Nc6 Bb5"), text);
check("their actual move is named", text.includes("they usually play a6"), text);
check("with the accuracy there", text.includes("54% accuracy"), text);
check("and the time spent, when known", text.includes("31s"), text);

console.log("7. Empty sections say so rather than going silent");
const thin: SelfProfile = {
  gamesIngested: 6,
  colours: [{ colour: "w", gamesScanned: 4, unconfirmed: 0, tactical: undefined, behaviour: undefined, weaknesses: [] }],
};
const thinText = describeSelfProfile(thin);
check("no tactical evidence is stated as such", thinText.includes("not enough evidence yet"), thinText);
check("it does not claim there is nothing wrong", !thinText.includes("no weaknesses"), thinText);
check("a single colour still renders", thinText.includes("As White"), thinText);

console.log(`\n${fail === 0 ? "✅ ALL PASS" : `❌ ${fail} FAILED`} (${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);
