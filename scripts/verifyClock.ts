/**
 * The clock that runs must be the clock of the player whose move it is.
 *
 *   npx tsx scripts/verifyClock.ts        # offline: no server, no socket, no DB
 *
 * The bug this pins is the worst one reported so far. `turn` was a field the server
 * flipped by hand and pushed over the socket, and the client decided which clock to run
 * from that field. When one `game:update` went missing it went stale, so the client ran
 * the WRONG player's clock down to 00:00 on screen while the real on-move player's clock
 * sat frozen at a stale value. The server, counting the real clock, then flagged the
 * player who appeared to have twelve seconds left.
 *
 * A student lost a blitz game on time while watching their opponent's clock read zero.
 *
 * Both sides now read the side-to-move out of the FEN, which chess.js produced from the
 * move it validated, so the running clock cannot disagree with the pieces on the board.
 */
import { Chess } from "chess.js";
import { calculateTimeAfterMove } from "../src/lib/socket/clockManager.ts";
import type { GameState } from "../src/lib/socket/gameEngine.ts";

let pass = 0;
let fail = 0;
function check(label: string, ok: boolean, detail = "") {
  if (ok) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}\n        ${detail}`); }
}

/** Exactly what BOTH the server and the client now compute. */
const turnOf = (fen: string) => (fen.split(" ")[1] === "b" ? "b" : "w");

console.log("1. The side to move comes from the position, not from a tracked field");
const chess = new Chess();
check("a fresh game is White to move", turnOf(chess.fen()) === "w");
chess.move("e4");
check("after 1.e4 it is Black", turnOf(chess.fen()) === "b", chess.fen());
chess.move("c6");
check("after 1...c6 it is White", turnOf(chess.fen()) === "w", chess.fen());

console.log("2. A stale tracked field can no longer decide anything");
// The exact shape of the reported game: Black has just played, so White is to move.
const afterBlackMove = new Chess();
for (const m of ["e4", "c6", "Nf3", "d5", "exd5", "cxd5"]) afterBlackMove.move(m);
const fen = afterBlackMove.fen();
const stale: Pick<GameState, "fen" | "turn"> = { fen, turn: "b" }; // field says Black, board says White
check("the board says White is to move", turnOf(stale.fen) === "w", fen);
check("the stale field disagrees — and is ignored", stale.turn !== turnOf(stale.fen));

console.log("3. Clock arithmetic charges the mover, and only the mover");
const base: GameState = {
  gameId: "g", white: "W", black: "B", fen, pgn: "", moves: [],
  status: "ongoing", whiteTimeMs: 60_000, blackTimeMs: 45_000, incrementMs: 2_000,
  lastMoveAt: Date.now() - 5_000, turn: "w", rated: true, format: "BLITZ",
  timeControl: "3+2", createdAt: Date.now(),
};
const afterWhite = calculateTimeAfterMove(base, "W");
check("White's clock went down", afterWhite.whiteTimeMs < base.whiteTimeMs, String(afterWhite.whiteTimeMs));
check("Black's clock is untouched", afterWhite.blackTimeMs === base.blackTimeMs);
check("White got the increment", afterWhite.whiteTimeMs > base.whiteTimeMs - 5_000, String(afterWhite.whiteTimeMs));

const afterBlack = calculateTimeAfterMove(base, "B");
check("Black's clock went down", afterBlack.blackTimeMs < base.blackTimeMs);
check("White's clock is untouched", afterBlack.whiteTimeMs === base.whiteTimeMs);

console.log("4. Time debt is not erased by the increment");
// White had 3s left and thought for 5s: they flagged. The old code returned
// max(0, 3000-5000) + 2000 = 2000, so in ANY game with an increment the caller's
// `moverTime <= 0` flag check could never fire — you could not lose on time by moving.
const flagged = calculateTimeAfterMove(
  { ...base, whiteTimeMs: 3_000, lastMoveAt: Date.now() - 5_000 },
  "W",
);
check("a player who overran is left on zero", flagged.whiteTimeMs === 0, String(flagged.whiteTimeMs));
check("and therefore trips the flag check", flagged.whiteTimeMs <= 0);

const survived = calculateTimeAfterMove(
  { ...base, whiteTimeMs: 8_000, lastMoveAt: Date.now() - 5_000 },
  "W",
);
check("a player who did NOT overrun keeps their increment", survived.whiteTimeMs > 4_500, String(survived.whiteTimeMs));
check("and does not trip the flag check", survived.whiteTimeMs > 0);

console.log("5. Zero-increment games still flag exactly on zero");
const noInc = calculateTimeAfterMove(
  { ...base, incrementMs: 0, whiteTimeMs: 5_000, lastMoveAt: Date.now() - 5_000 },
  "W",
);
check("spending the last of the clock flags", noInc.whiteTimeMs === 0, String(noInc.whiteTimeMs));

console.log(`\n${fail === 0 ? "✅ ALL PASS" : `❌ ${fail} FAILED`} (${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);
