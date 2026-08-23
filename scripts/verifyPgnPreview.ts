/**
 * Offline verification of the paste-preview parser (Phase 5).
 *
 *   npx tsx scripts/verifyPgnPreview.ts
 *
 * Feeds a paste that mixes a valid game, a broken-moves game, a no-date game, a
 * game whose players match neither the profiled name, and a duplicate — then
 * asserts the accepted/rejected split and that `forcedColor` rescues the
 * unmatched-side game. Pure parse: no DB, no engine, no network.
 */
import { previewPastedPgn } from "../src/lib/second/pgnImport";

const PLAYER = "Kapadi Yash";

const G1 = `[Event "Club"]
[Date "2024.01.15"]
[White "Kapadi Yash"]
[Black "Some Opponent"]
[Result "1-0"]

1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 1-0`;

const G2_BROKEN = `[Event "Club"]
[Date "2024.02.10"]
[White "Kapadi Yash"]
[Black "X"]
[Result "0-1"]

1. e4 e5 2. xyz 0-1`;

const G3_NODATE = `[Event "Club"]
[White "Kapadi Yash"]
[Black "Y"]
[Result "1/2-1/2"]

1. d4 d5 1/2-1/2`;

const G4_NEITHER = `[Event "Club"]
[Date "2024.03.01"]
[White "Alice"]
[Black "Bob"]
[Result "1-0"]

1. c4 e5 2. Nc3 Nf6 1-0`;

const PASTE = [G1, G2_BROKEN, G3_NODATE, G4_NEITHER, G1 /* duplicate */].join("\n\n");

function check(label: string, ok: boolean, detail = ""): boolean {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  return ok;
}

function main() {
  let allPass = true;

  // 1) Name-only: game 4 (neither side matches) should be rejected.
  const a = previewPastedPgn(PASTE, { playerName: PLAYER, max: 15 });
  console.log("Name-only preview:", a.accepted.length, "accepted,", a.rejected.length, "rejected");
  console.log("  reasons:", a.rejected.map((r) => `${r.label}: ${r.reason}`).join(" | "));
  allPass = check("1 game accepted", a.accepted.length === 1, `${a.accepted.length}`) && allPass;
  allPass = check("4 games rejected", a.rejected.length === 4, `${a.rejected.length}`) && allPass;
  allPass = check("a 'which side' rejection present", a.rejected.some((r) => /which side/i.test(r.reason))) && allPass;
  allPass = check("a 'date' rejection present", a.rejected.some((r) => /date/i.test(r.reason))) && allPass;
  allPass = check("a 'duplicate' rejection present", a.rejected.some((r) => /duplicate/i.test(r.reason))) && allPass;
  const g1 = a.accepted[0];
  allPass = check("accepted game maps result/opening/date", !!g1 && g1.result === "won" && g1.date === "2024-01-15" && g1.moveCount === 3, JSON.stringify(g1)) && allPass;

  // 2) forcedColor="w" rescues the neither-side game (opponent = White).
  const b = previewPastedPgn(PASTE, { playerName: PLAYER, forcedColor: "w", max: 15 });
  console.log("\nForced-white preview:", b.accepted.length, "accepted,", b.rejected.length, "rejected");
  allPass = check("forcedColor rescues the unmatched game (2 accepted)", b.accepted.length === 2, `${b.accepted.length}`) && allPass;
  allPass = check("no 'which side' rejection remains", !b.rejected.some((r) => /which side/i.test(r.reason))) && allPass;

  // 3) The 15-game cap is enforced.
  const many = Array.from({ length: 20 }, (_, i) =>
    `[Event "C"]\n[Date "2024.01.${String((i % 28) + 1).padStart(2, "0")}"]\n[White "Kapadi Yash"]\n[Black "O${i}"]\n[Result "1-0"]\n\n1. e4 e5 2. Nf3 Nc6 3. d4 exd4 1-0`,
  ).join("\n\n");
  const c = previewPastedPgn(many, { playerName: PLAYER, max: 15 });
  allPass = check("cap enforced (<=15 accepted)", c.accepted.length <= 15, `${c.accepted.length}`) && allPass;
  allPass = check("over-limit games rejected", c.rejected.some((r) => /limit/i.test(r.reason))) && allPass;

  console.log(allPass ? "\n✅ ALL PASS" : "\n❌ SOME CHECKS FAILED");
  process.exit(allPass ? 0 : 1);
}

main();
