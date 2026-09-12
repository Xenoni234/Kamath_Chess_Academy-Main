/**
 * A finished game's database row renders as a game you PLAYED, not one you watched.
 *
 *   npx tsx scripts/verifyGameState.ts        # offline: no server, no database
 *
 * The bug this pins: `game/[gameId]/page.tsx` handed the Postgres row straight to the
 * client as `dbGame as unknown as GameState`. The shapes do not match — the row calls the
 * players `whiteUserId`/`blackUserId` and carries no `status` and no `turn` — and the
 * double cast silenced all of it. `game.white` arrived `undefined`, so `isPlayer` was
 * false and BOTH real players were shown "Spectating"; Black also got a white-oriented
 * board and the result modal never rendered.
 *
 * Redis drops a game five minutes after it ends, so every game reopened from the history
 * list took that path. It was not an edge case, and it could not self-heal: a false
 * `isPlayer` makes the client emit `game:spectate`, the server finds nothing in Redis and
 * answers `game:error`, which had no listener.
 *
 * The assertions below mirror exactly what `GameRoomClient` computes from the result:
 *   isPlayer    = userId === game.white || userId === game.black
 *   orientation = userId === game.black ? "black" : "white"
 * so a regression here fails for the same reason a human would notice it.
 */
import { Chess } from "chess.js";
import { gameStateFromDbRow, type PersistedGameRow } from "../src/lib/socket/gameEngine.ts";

let pass = 0;
let fail = 0;
function check(label: string, ok: boolean, detail = "") {
  if (ok) {
    pass++;
    console.log(`  PASS  ${label}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label} ${detail}`);
  }
}

const WHITE_ID = "usr_white_abc";
const BLACK_ID = "usr_black_xyz";
const STRANGER = "usr_nobody_999";

function row(overrides: Partial<PersistedGameRow> = {}): PersistedGameRow {
  return {
    id: "game_cuid_1",
    whiteUserId: WHITE_ID,
    blackUserId: BLACK_ID,
    pgn: "1. e4 e5 2. Nf3 Nc6",
    fen: "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 4 3",
    moves: ["e2e4", "e7e5", "g1f3", "b8c6"],
    timeControl: "5+0",
    timeFormat: "BLITZ",
    result: "WHITE_WIN",
    termination: "checkmate",
    rated: true,
    whiteTimeMs: 120_000,
    blackTimeMs: 95_000,
    incrementMs: 0,
    lastMoveAt: new Date("2026-09-12T10:05:00Z"),
    tournamentId: null,
    createdAt: new Date("2026-09-12T10:00:00Z"),
    ...overrides,
  };
}

/** Exactly what GameRoomClient derives. */
const isPlayer = (g: { white: string; black: string }, userId: string) =>
  userId === g.white || userId === g.black;
const orientation = (g: { black: string }, userId: string) => (userId === g.black ? "black" : "white");

console.log("1. The players are players — the bug that started this");
const g = gameStateFromDbRow(row());
check("white is the white user's id", g.white === WHITE_ID, `got ${JSON.stringify(g.white)}`);
check("black is the black user's id", g.black === BLACK_ID, `got ${JSON.stringify(g.black)}`);
check("White sees 'Playing as', not 'Spectating'", isPlayer(g, WHITE_ID));
check("Black sees 'Playing as', not 'Spectating'", isPlayer(g, BLACK_ID));
check("Black's board is oriented black", orientation(g, BLACK_ID) === "black", orientation(g, BLACK_ID));
check("White's board is oriented white", orientation(g, WHITE_ID) === "white");
check("a stranger really is a spectator", !isPlayer(g, STRANGER));

console.log("2. Status and result, which the cast also lost");
check("a persisted game is finished", g.status === "finished", g.status);
check("gameId comes from the row's id", g.gameId === "game_cuid_1", g.gameId);
check("WHITE_WIN maps to 'white'", g.result === "white", String(g.result));
check("BLACK_WIN maps to 'black'", gameStateFromDbRow(row({ result: "BLACK_WIN" })).result === "black");
check("DRAW maps to 'draw'", gameStateFromDbRow(row({ result: "DRAW" })).result === "draw");
const aborted = gameStateFromDbRow(row({ result: "ABORT" }));
check("ABORT has no winner", aborted.result === undefined, String(aborted.result));
check("ABORT is 'aborted', not 'finished'", aborted.status === "aborted", aborted.status);

console.log("3. Turn is derived, never guessed");
check("white to move is read from the FEN", g.turn === "w", g.turn);
const blackToMove = gameStateFromDbRow(
  row({ fen: "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 2" }),
);
check("black to move is read from the FEN", blackToMove.turn === "b", blackToMove.turn);

console.log("4. A row with no FEN replays the PGN rather than showing the start position");
const noFen = gameStateFromDbRow(row({ fen: null }));
const replayed = new Chess();
replayed.loadPgn("1. e4 e5 2. Nf3 Nc6");
check("the position is the end of the game", noFen.fen === replayed.fen(), noFen.fen);
check("and it is not the starting position", noFen.fen !== new Chess().fen());

console.log("5. Dates become epoch millis, nullable clocks become numbers");
check("createdAt is a number", typeof g.createdAt === "number" && g.createdAt > 0);
check("lastMoveAt is a number", typeof g.lastMoveAt === "number" && g.lastMoveAt > 0);
const noClocks = gameStateFromDbRow(row({ whiteTimeMs: null, blackTimeMs: null, incrementMs: null, lastMoveAt: null }));
check("null clocks become 0, never undefined", noClocks.whiteTimeMs === 0 && noClocks.blackTimeMs === 0);
check("a null lastMoveAt falls back to createdAt", noClocks.lastMoveAt === g.createdAt, String(noClocks.lastMoveAt));
check("format comes from timeFormat", g.format === "BLITZ", g.format);
check("termination survives", g.termination === "checkmate", String(g.termination));

console.log("6. A deleted account cannot be mistaken for the viewer");
// The relation is SetNull, so a deleted user leaves a null id. Empty string is the right
// stand-in: it is a string, so the comparison stays a plain `===`, and no authenticated
// user id can equal it — `userId` is always a cuid read from a verified JWT
// (game/[gameId]/page.tsx), never absent and never empty. That is the guarantee asserted
// here; `isPlayer(orphan, "")` would be true, but an empty viewer id cannot reach this code.
const orphan = gameStateFromDbRow(row({ whiteUserId: null }));
check("a null player id becomes an empty string", orphan.white === "", JSON.stringify(orphan.white));
check("no real user id matches the empty slot", !isPlayer(orphan, STRANGER) && !isPlayer(orphan, WHITE_ID));
check("the surviving opponent is still a player", isPlayer(orphan, BLACK_ID));

console.log(`\n${fail === 0 ? "✅ ALL PASS" : `❌ ${fail} FAILED`} (${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);
