/**
 * End-to-end check of the whole-game scan and the two profiles it feeds.
 *
 * Exercises the real pipeline against a real account without needing the web
 * app or a login: ingest -> scan -> tactical -> behavioural, with timings.
 *
 * Worth keeping and re-running after any change to ingestion, the scan or the
 * profiles. It has already caught two bugs that typechecking could not: clock
 * arrays being discarded wholesale, and the scan running on one engine instead
 * of the pool.
 *
 * Run: npx tsx --env-file=.env.local scripts/verifyScan.ts <handle> [LICHESS|CHESSCOM] [games]
 */
import { fetchOpponentGamesMulti } from "../src/lib/second/ingest";
import { scanGames } from "../src/lib/second/scan";
import { profileTactics } from "../src/lib/second/tactics";
import { profileBehaviour } from "../src/lib/second/behaviour";
import type { OpponentSource } from "../src/lib/second/types";

const handle = process.argv[2] ?? "DrNykterstein";
const source = (process.argv[3] ?? "LICHESS") as OpponentSource;
const maxGames = Number(process.argv[4] ?? 30);

function secs(from: number) {
  return `${((Date.now() - from) / 1000).toFixed(1)}s`;
}

async function main() {
  console.log(`Profiling ${handle} (${source}), ${maxGames} games\n`);

  let t = Date.now();
  const merged = await fetchOpponentGamesMulti([{ handle, source }], {
    perAccountMax: maxGames,
    totalMax: maxGames,
  });
  console.log(`ingest: ${secs(t)} — ${merged.games.length} games`);
  console.log("  diagnostics:", JSON.stringify(merged.diagnostics));
  console.log("  account:", JSON.stringify(merged.accounts[0]));

  // Sanity-check the Stage 1 fields that everything downstream depends on.
  const sample = merged.games[0];
  if (!sample) {
    console.log("\nNo games — nothing to scan.");
    return;
  }
  console.log("\nsample game:");
  console.log(
    "  ",
    JSON.stringify({
      gameKey: sample.gameKey,
      color: sample.color,
      termination: sample.termination,
      terminationRaw: sample.terminationRaw,
      timeControl: sample.timeControl,
      rated: sample.rated,
      playerRating: sample.playerRating,
      opponentRating: sample.opponentRating,
      endedAt: sample.endedAt?.toISOString(),
      plies: sample.san.split(/\s+/).length,
      clocks: sample.clocks?.length ?? null,
      weight: Number(sample.weight.toFixed(3)),
    }),
  );

  const withClocks = merged.games.filter((g) => g.clocks).length;
  const withIncrement = merged.games.filter((g) => g.timeControl.incrementSec !== null).length;
  const unknownTermination = merged.games.filter((g) => g.termination === "unknown").length;
  console.log(
    `\n  ${withClocks}/${merged.games.length} games have clocks, ` +
      `${withIncrement} have a known increment, ` +
      `${unknownTermination} have an unknown termination`,
  );

  // Scan whichever colour they played more, so the sample is the larger one.
  const whites = merged.games.filter((g) => g.color === "w").length;
  const color: "w" | "b" = whites >= merged.games.length / 2 ? "w" : "b";

  t = Date.now();
  const scan = await scanGames(merged.games, color);
  const scanSecs = (Date.now() - t) / 1000;
  console.log(
    `\nscan: ${scanSecs.toFixed(1)}s — ${scan.games.length} games as ${color}, ` +
      `${scan.moves.length} moves graded, ${scan.positionsEvaluated} engine positions`,
  );
  if (scan.games.length > 0) {
    console.log(
      `  ≈ ${(scanSecs / scan.games.length).toFixed(2)}s per game ` +
        `→ 200 games ≈ ${((scanSecs / scan.games.length) * 200 / 60).toFixed(1)} min`,
    );
  }

  const tactical = profileTactics(scan.moves, scan.games.length);
  console.log(`\ntactical (min ${tactical.minOpportunities} opportunities to report a rate):`);
  if (tactical.motifs.length === 0) console.log("  (no motifs seen at all)");
  for (const m of tactical.motifs) {
    const thin = m.opportunities < tactical.minOpportunities ? "  [thin]" : "";
    console.log(
      `  ${m.motif.padEnd(18)} opportunities ${String(m.opportunities).padStart(4)}` +
        `  found ${String(m.found).padStart(4)}  missed ${String(m.missed).padStart(4)}` +
        `  ${(m.missRate * 100).toFixed(0)}% [${(m.missRateLow * 100).toFixed(0)}-${(m.missRateHigh * 100).toFixed(0)}]${thin}`,
    );
  }

  const behaviour = profileBehaviour(scan.games, scan.moves);
  console.log(
    `\nbehavioural (min ${behaviour.minSamples} moves per bucket; clocks usable: ${behaviour.clockDataAvailable}):`,
  );
  const groups: [string, typeof behaviour.timePressure][] = [
    ["clock", behaviour.timePressure],
    ["think", behaviour.longThink],
    ["tilt", behaviour.tilt],
    ["structure", behaviour.structures],
  ];
  for (const [name, buckets] of groups) {
    for (const b of buckets) {
      const thin = b.n < behaviour.minSamples ? "  [hidden: thin]" : "";
      console.log(
        `  ${name.padEnd(10)} ${b.label.padEnd(28)} ${b.accuracy.toFixed(1)}%` +
          ` [${b.accuracyLow.toFixed(1)}-${b.accuracyHigh.toFixed(1)}]` +
          `  blunders ${(b.blunderRate * 100).toFixed(0)}%  n=${b.n}${thin}`,
      );
    }
  }
  console.log(`  losses analysed: ${behaviour.lossesAnalyzed}`);
  for (const t2 of behaviour.terminations) {
    console.log(`    ${t2.label.padEnd(22)} ${t2.count} (${(t2.share * 100).toFixed(0)}%)`);
  }

  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
