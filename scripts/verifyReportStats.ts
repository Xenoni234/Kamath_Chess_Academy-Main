/**
 * The report's opening tables must pool evidence and refuse to state a rate without it.
 *
 *   npx tsx scripts/verifyReportStats.ts       # offline: no engine, no network, no DB
 *
 * The bug this pins came straight off a real production report. 36 games scattered into
 * ~30 "openings", because the sources name them down to the exact move order:
 *
 *   Closed Sicilian Defense Portland Attack 3...g6 4.Be3   1 game   100.0%
 *   Colle System 3...e6 4.Bd3 Bd6 5.Nbd2                   1 game     0.0%
 *   Colle System Rubinstein Opening 5...Nc6 6.O O          1 game     0.0%
 *
 * Two of those are the same opening. None of them support a percentage. The narrative
 * then told a nine-year-old they had "a 100% win rate in the Closed Sicilian" — from one
 * game — and that their Colle System was a 0% disaster, from one game they had drawn.
 */
import { openingFamily, MIN_OPENING_GAMES } from "../src/lib/reports/gameStats.ts";

let pass = 0;
let fail = 0;
function check(label: string, ok: boolean, detail = "") {
  if (ok) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}\n        ${detail}`); }
}

console.log("1. The exact names from the real report");
const colle1 = openingFamily("Colle System 3...e6 4.Bd3 Bd6 5.Nbd2");
const colle2 = openingFamily("Colle System Rubinstein Opening 5...Nc6 6.O O");
check("the two Colle games become ONE opening", colle1 === colle2, `${colle1} vs ${colle2}`);
check("and it is named 'Colle System'", colle1 === "Colle System", colle1);
check(
  "the Sicilian keeps its family name",
  openingFamily("Closed Sicilian Defense Portland Attack 3...g6 4.Be3") === "Closed Sicilian Defense",
  openingFamily("Closed Sicilian Defense Portland Attack 3...g6 4.Be3"),
);
check(
  "Queens Pawn variants pool",
  openingFamily("Queens Pawn Opening Anti Torre Attack") ===
    openingFamily("Queens Pawn Opening Levitsky Attack"),
  openingFamily("Queens Pawn Opening Anti Torre Attack"),
);
check(
  "Indian Game drops the sub-variation",
  openingFamily("Indian Game Yusupov Rubinstein System 3...c5 4.Bd3 cxd4 5.exd4") === "Indian Game",
  openingFamily("Indian Game Yusupov Rubinstein System 3...c5 4.Bd3 cxd4 5.exd4"),
);

console.log("2. Lichess's own naming format");
check(
  "the part before the colon wins",
  openingFamily("Sicilian Defense: Najdorf Variation, English Attack") === "Sicilian Defense",
  openingFamily("Sicilian Defense: Najdorf Variation, English Attack"),
);
check(
  "a comma-separated variation is dropped",
  openingFamily("French Defense, Advance Variation") === "French Defense",
  openingFamily("French Defense, Advance Variation"),
);

console.log("3. Move lists never survive into a name");
for (const name of [
  "Colle System 3...e6 4.Bd3",
  "Ruy Lopez 1.e4 e5 2.Nf3",
  "Queens Gambit 2. c4",
]) {
  const out = openingFamily(name);
  check(`no digits left in "${out}"`, !/\d/.test(out), out);
}

console.log("4. Degenerate input does not produce a blank row");
check("empty string is named", openingFamily("") === "Unknown Opening", openingFamily(""));
check("whitespace is named", openingFamily("   ") === "Unknown Opening", openingFamily("   "));
check("a bare move list is named", openingFamily("1.e4 e5") === "Unknown Opening", openingFamily("1.e4 e5"));
check("an unknown name survives", openingFamily("Unknown Opening") === "Unknown Opening");

console.log("5. Grouping never invents a family that swallows everything");
const distinct = new Set(
  [
    "Sicilian Defense: Najdorf",
    "French Defense, Advance",
    "Caro-Kann Defense: Panov",
    "Colle System 3...e6",
    "Ruy Lopez: Berlin Defense",
  ].map(openingFamily),
);
check("five different openings stay five", distinct.size === 5, [...distinct].join(" | "));

console.log("6. The minimum-sample floor is a real floor");
check("it is at least 3 games", MIN_OPENING_GAMES >= 3, String(MIN_OPENING_GAMES));

console.log(`\n${fail === 0 ? "✅ ALL PASS" : `❌ ${fail} FAILED`} (${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);
