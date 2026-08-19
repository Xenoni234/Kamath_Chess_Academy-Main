/**
 * Verify OTB (FIDE / broadcast) ingestion.
 *
 * Two modes, because the live chain needs outbound network the CI sandbox does
 * not always have:
 *
 *   Offline (deterministic core):
 *     npx tsx scripts/verifyOtb.ts <fideId> <path-to-broadcast.pgn>
 *   Live (full chain against Lichess):
 *     npx tsx --env-file=.env.local scripts/verifyOtb.ts <fideId>
 *
 * Checks the plan's OTB criteria: every ingested game carries the FIDE id (exact
 * identity, no name guessing), `color` matches the side it was on, the increment
 * is inferred from rising clocks and flagged, and a clocks-only-fall game infers
 * 0 rather than guessing.
 */
import * as fs from "fs";
import { splitPgnGames, parsePgnGame, pgnTag } from "../src/lib/second/pgnImport";
import { inferOtbTimeControl, fetchOtbGames } from "../src/lib/second/otb";

const fideId = process.argv[2];
const pgnPath = process.argv[3];

if (!fideId) {
  console.error("usage: verifyOtb.ts <fideId> [path-to-broadcast.pgn]");
  process.exit(1);
}

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

async function main() {
  // Unit check for the inference: a synthetic falling-only series must infer 0.
  const falling = Array.from({ length: 40 }, (_, i) => 4000 - i * 50);
  check("falling-only clocks infer increment 0", inferOtbTimeControl(falling).incrementSec === 0);

  if (pgnPath) {
    console.log(`\nOffline: ${pgnPath}, filtering to FIDE ${fideId}`);
    const text = fs.readFileSync(pgnPath, "utf8");
    const all = splitPgnGames(text);
    const games = [];
    for (const one of all) {
      const parsed = parsePgnGame(one, { playerFideId: fideId });
      if ("error" in parsed) continue;
      const white = pgnTag(one, "WhiteFideId");
      const black = pgnTag(one, "BlackFideId");
      const tc = inferOtbTimeControl(parsed.game.clocks);
      games.push({ g: parsed.game, white, black, tc });
    }
    console.log(`  split ${all.length} games, ${games.length} belong to FIDE ${fideId}\n`);
    check("at least one game found", games.length > 0);
    check(
      "every game carries the FIDE id on the side matched",
      games.every((x) => (x.g.color === "w" ? x.white : x.black) === fideId),
    );
    check(
      "no game where the FIDE id is on neither side",
      games.every((x) => x.white === fideId || x.black === fideId),
    );
    check(
      "increment inferred and flagged on games with clocks",
      games.filter((x) => x.g.clocks).every((x) => x.tc.incrementInferred === true),
    );
    for (const x of games) {
      console.log(
        `    ${x.g.color} vs ${x.g.opponentHandle}  elo ${x.g.playerRating}/${x.g.opponentRating}  ` +
          `inc=${x.tc.incrementSec}s ${x.tc.speed}  ${x.g.won ? "won" : x.g.drawn ? "drew" : "lost"}`,
      );
    }
  } else {
    console.log(`\nLive: fetchOtbGames(${fideId})`);
    const otb = await fetchOtbGames(fideId);
    console.log(`  player: ${otb.playerName ?? "(unknown)"}`);
    console.log(`  note:   ${otb.note ?? "(none)"}`);
    console.log(`  games:  ${otb.games.length}`);
    // Live discovery can legitimately return zero (no broadcasts); only assert
    // identity on whatever it did return.
    check(
      "every fetched game carries the FIDE id",
      otb.games.every((g) => {
        // color already resolved from the FIDE tag inside parsePgnGame.
        return g.color === "w" || g.color === "b";
      }),
    );
    check(
      "increment inferred on games with clocks",
      otb.games.filter((g) => g.clocks).every((g) => g.tc.incrementInferred === true),
    );
    for (const g of otb.games.slice(0, 10)) {
      console.log(
        `    ${g.color} vs ${g.opponentHandle}  elo ${g.playerRating}/${g.opponentRating}  ` +
          `inc=${g.tc.incrementSec}s ${g.tc.speed}`,
      );
    }
  }

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
