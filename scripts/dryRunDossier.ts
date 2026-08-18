/**
 * Full dossier dry run — everything runProfileJob does except the DB writes.
 *
 * ingest (multi-account) -> trie -> weaknesses -> scan -> tactical + behavioural
 * -> artifact -> repertoire lines -> description -> PDF HTML.
 *
 * Exists because the stages had only ever been exercised individually: this is
 * the first thing that proves the artifact actually assembles and the new
 * sections actually reach the PDF. Writes nothing to Postgres.
 *
 * Run: npx tsx --env-file=.env.local scripts/dryRunDossier.ts
 */
import { writeFileSync } from "node:fs";
import { fetchOpponentGamesMulti } from "../src/lib/second/ingest";
import { buildTrie, trieSummaryLines } from "../src/lib/second/trie";
import { detectWeaknesses } from "../src/lib/second/weakness";
import { scanGames } from "../src/lib/second/scan";
import { profileTactics } from "../src/lib/second/tactics";
import { profileBehaviour } from "../src/lib/second/behaviour";
import { buildRepertoireLines, describeArtifact } from "../src/lib/second/repertoire";
import { renderDossierHtml } from "../src/lib/second/pdf";
import type { AccountRef, ProfileArtifact } from "../src/lib/second/types";

const ACCOUNTS: AccountRef[] = [
  { handle: "Hikaru", source: "CHESSCOM" },
  { handle: "DrNykterstein", source: "LICHESS" },
];
const PER_ACCOUNT = 25;

function secs(t: number) { return `${((Date.now() - t) / 1000).toFixed(1)}s`; }

async function main() {
  let t = Date.now();
  const merged = await fetchOpponentGamesMulti(ACCOUNTS, {
    perAccountMax: PER_ACCOUNT,
    totalMax: PER_ACCOUNT * ACCOUNTS.length,
  });
  console.log(`ingest: ${secs(t)} — ${merged.games.length} games merged`);
  for (const a of merged.accounts) {
    console.log(`  ${a.handle.padEnd(16)} ${a.source.padEnd(9)} used=${String(a.gamesUsed).padStart(3)} meanWeight=${a.meanWeight.toFixed(3)} status=${a.status}`);
  }
  console.log("  diagnostics:", JSON.stringify(merged.diagnostics));

  // The accounting the plan says must close.
  const d = merged.diagnostics;
  const used = merged.accounts.reduce((s, a) => s + a.gamesUsed, 0);
  const expected = d.totalFetched - d.duplicatesDropped - d.selfPlayDropped - d.noTimestampDropped - d.budgetTrimmed;
  console.log(`  accounting: used=${used} expected=${expected} ${used === expected ? "OK" : "MISMATCH"}`);

  if (merged.games.length === 0) { console.log("no games"); return; }

  const whites = merged.games.filter((g) => g.color === "w").length;
  const theirColor: "w" | "b" = whites >= merged.games.length / 2 ? "w" : "b";

  t = Date.now();
  const trie = buildTrie(merged.games, theirColor);
  const trieSummary = trieSummaryLines(trie);
  const { weaknesses, clockBasis } = await detectWeaknesses(merged.games, theirColor);
  console.log(`\nweakness: ${secs(t)} — ${weaknesses.length} found, clockBasis=${JSON.stringify(clockBasis)}`);

  t = Date.now();
  const scan = await scanGames(merged.games, theirColor);
  const tactical = profileTactics(scan.moves, scan.games.length);
  const behaviour = profileBehaviour(scan.games, scan.moves);
  console.log(`scan+profiles: ${secs(t)} — ${scan.moves.length} moves, ${tactical.motifs.length} motifs, ${behaviour.structures.length} structure buckets`);

  const artifact: ProfileArtifact = {
    handle: ACCOUNTS[0].handle,
    source: ACCOUNTS[0].source,
    accounts: merged.accounts,
    ingest: merged.diagnostics,
    recencyReferenceAt: new Date(merged.recencyReferenceMs).toISOString(),
    clockBasis,
    colorToPlay: theirColor === "w" ? "black" : "white",
    gamesAnalyzed: merged.games.filter((g) => g.color === theirColor).length,
    ratingSummary: merged.ratingSummary,
    trieSummary,
    weaknesses,
    transpositions: [],
    novelties: [],
    tactical,
    behaviour,
    graphUsed: false,
    graphSkipReason: "not-configured",
  };

  const lines = buildRepertoireLines(artifact);
  const description = describeArtifact(artifact, lines);
  const html = renderDossierHtml(artifact, lines, "Dry run — narrative not generated.");
  writeFileSync("/tmp/dossier-dryrun.html", html);

  console.log(`\nartifact assembled: ${lines.length} repertoire lines, description ${description.length} chars`);
  console.log(`PDF HTML: ${html.length} chars -> /tmp/dossier-dryrun.html`);
  for (const heading of ["Sources", "Tactical profile", "Behavioural patterns", "Their weakest positions"]) {
    console.log(`  section "${heading}": ${html.includes(`<h2>${heading}</h2>`) ? "present" : "MISSING"}`);
  }
  console.log("\n--- description head ---\n" + description.slice(0, 900));
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
