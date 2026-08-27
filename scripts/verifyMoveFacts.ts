/**
 * Offline verification of the move-fact builder (the AI explainer's ground truth).
 *
 *   npx tsx scripts/verifyMoveFacts.ts
 *
 * The AI is only allowed to narrate what this module produces, so these facts
 * must be right. Positions with known, checkable truth — including the quiet
 * move, which must produce NO tactic at all (the false-positive case that made
 * the old explainer invent forks out of nothing).
 *
 * Pure: no engine, no network, no DB. Engine scores are supplied synthetically
 * so the maths and point-of-view handling are exercised deterministically.
 */
import { buildMoveFacts, type MoveFactsInput } from "../src/lib/analysis/moveFacts";
import type { MultiPvMove } from "../src/lib/engine/serverEngine";

let failures = 0;

function check(label: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
}

function line(uci: string, cp: number | null, mate: number | null = null, pv: string[] = []): MultiPvMove {
  return { uci, cp, mate, pv: pv.length ? pv : [uci] };
}

function facts(input: MoveFactsInput) {
  const f = buildMoveFacts(input);
  if (!f) throw new Error("buildMoveFacts returned null for a legal move");
  return f;
}

// 1. Scholar's mate — Qxf7# is a capture AND mate.
console.log("\n1. Scholar's mate (Qxf7#)");
{
  const fen = "r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4";
  const f = facts({ fenBefore: fen, playedUci: "h5f7", lines: [line("h5f7", null, 1)], after: { cp: null, mate: 1, pv: [] } });
  check("SAN is Qxf7#", f.played.san === "Qxf7#", f.played.san);
  check("detected as mate", f.played.isMate === true);
  check("detected as capture of a pawn", f.played.isCapture && f.played.captured === "pawn", String(f.played.captured));
  check("student is White", f.student === "White", f.student);
  check("mate renders as M1, not a number", f.evalBefore === "M1", String(f.evalBefore));
  // The board is stated, not left for the model to decode — and g8 is EMPTY here
  // (the knight is on f6). A model reading the FEN claimed a knight on g8.
  check("piece list has the knight on f6, not g8", f.pieces.black.includes("Nf6") && !f.pieces.black.includes("Ng8"), f.pieces.black);
  check("piece list has White's queen on h5", f.pieces.white.includes("Qh5"), f.pieces.white);
  check("mate-score cpLoss artefact withheld", f.cpLoss === null, String(f.cpLoss));
  // f7's real defender is the KING on e8 — a knight on f6 does not defend f7,
  // which is precisely the relationship a model invented when left to guess.
  check("f7 defended by Ke8 only", f.target.theirs === "Ke8", f.target.theirs);
  check("f7 attacked by Qh5 and Bc4", f.target.yours === "Bc4, Qh5", f.target.yours);
}

// 2. Knight fork — Nc7+ hits king and rook.
console.log("\n2. Knight fork (Nc7+)");
{
  const fen = "r3k3/8/8/1N6/8/8/8/4K3 w - - 0 1";
  const f = facts({ fenBefore: fen, playedUci: "b5c7", lines: [line("b5c7", 500)], after: { cp: 500, mate: null, pv: [] } });
  check("SAN is Nc7+", f.played.san === "Nc7+", f.played.san);
  check("gives check", f.played.isCheck === true);
  check("fork detected", f.played.motifs.includes("fork"), f.played.motifs.join(",") || "none");
}

// 3. Capturing a completely undefended piece.
console.log("\n3. Hanging piece (Bxf6)");
{
  const fen = "4k3/8/5n2/8/8/8/1B6/4K3 w - - 0 1";
  const f = facts({ fenBefore: fen, playedUci: "b2f6", lines: [line("b2f6", 300)], after: { cp: 300, mate: null, pv: [] } });
  check("SAN is Bxf6", f.played.san === "Bxf6", f.played.san);
  check("captured a knight", f.played.captured === "knight", String(f.played.captured));
  check("hangingPiece detected", f.played.motifs.includes("hangingPiece"), f.played.motifs.join(",") || "none");
}

// 4. THE IMPORTANT ONE — a quiet opening move must claim no tactic whatsoever.
console.log("\n4. Quiet move (1.e4) — must invent nothing");
{
  const fen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
  const f = facts({ fenBefore: fen, playedUci: "e2e4", lines: [line("e2e4", 30, null, ["e2e4", "e7e5", "g1f3"])], after: { cp: 30, mate: null, pv: [] } });
  check("SAN is e4", f.played.san === "e4", f.played.san);
  check("NO motifs claimed", f.played.motifs.length === 0, f.played.motifs.join(",") || "none");
  check("no missed tactic claimed", f.missedMotifs.length === 0);
  check("not a capture or check", !f.played.isCapture && !f.played.isCheck);
  check("phase is opening", f.phase === "opening", f.phase);
  check("material level", f.material === "material is level", f.material);
  check("engine line is numbered", f.best?.line.startsWith("1.e4") === true, f.best?.line ?? "none");
}

// 5. Point of view — the same White-POV score must flip for a Black student.
console.log("\n5. Point of view (Black to move)");
{
  const fen = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
  const f = facts({ fenBefore: fen, playedUci: "e7e5", lines: [line("e7e5", 100)], after: { cp: 100, mate: null, pv: [] } });
  check("student is Black", f.student === "Black", f.student);
  check("White +1.00 shown to Black as -1.00", f.evalBefore === "-1.00", String(f.evalBefore));
  const g = facts({ fenBefore: fen, playedUci: "e7e5", lines: [line("e7e5", null, 3)], after: { cp: null, mate: 3, pv: [] } });
  check("White mate-in-3 shown to Black as -M3", g.evalBefore === "-M3", String(g.evalBefore));
}

// 6. Cost of a bad move — cpLoss/classification need the AFTER score.
console.log("\n6. Blunder accounting");
{
  const fen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
  const f = facts({
    fenBefore: fen,
    playedUci: "g1h3",
    lines: [line("e2e4", 100, null, ["e2e4"]), line("d2d4", 90, null, ["d2d4"])],
    after: { cp: -200, mate: null, pv: ["e7e5", "d2d4"] },
  });
  check("cpLoss = 300", f.cpLoss === 300, String(f.cpLoss));
  check("classified a blunder", f.classification === "blunder", String(f.classification));
  check("played move was not best", f.playedWasBest === false);
  check("a refutation line is offered", Boolean(f.refutation), f.refutation ?? "none");
  check("alternatives listed with evals", f.alternatives.length === 2 && f.alternatives[0].eval === "+1.00", JSON.stringify(f.alternatives[0]));
  check("allowed-move list includes played + best", f.allowedMoves.includes("Nh3") && f.allowedMoves.includes("e4"), f.allowedMoves.join(" "));
}

// 7. Missing engine data must stay unknown, never "0.00".
console.log("\n7. Missing engine data is admitted, not faked");
{
  const fen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
  const f = facts({ fenBefore: fen, playedUci: "e2e4", lines: [], after: null });
  check("no eval invented", f.evalBefore === null && f.evalAfter === null);
  check("no cpLoss invented", f.cpLoss === null);
  check("no classification invented", f.classification === null);
  check("no best move claimed", f.best === null);
}

// 8. An illegal move is rejected outright.
console.log("\n8. Illegal input rejected");
{
  const fen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
  check("illegal move → null", buildMoveFacts({ fenBefore: fen, playedUci: "e2e5", lines: [] }) === null);
  check("garbage FEN → null", buildMoveFacts({ fenBefore: "not-a-fen", playedUci: "e2e4", lines: [] }) === null);
}

console.log(failures === 0 ? "\n✅ ALL PASS" : `\n❌ ${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
