import type { Server } from "socket.io";
import { Chess } from "chess.js";
import { GameResult, TimeFormat } from "@prisma/client";
import { v4 as uuidv4 } from "uuid";
import { db } from "../db.ts";
import { redis } from "../redis.ts";
import { calculateTimeAfterMove as calculateClockAfterMove, parseTimeControl } from "./clockManager.ts";
import { updateRatings } from "./ratingEngine.ts";
import { applyTournamentResult } from "../tournament/scoring.ts";

export type GameState = {
  gameId: string;
  white: string;
  black: string;
  fen: string;
  pgn: string;
  moves: string[];
  status: "waiting" | "ongoing" | "finished" | "aborted";
  result?: "white" | "black" | "draw";
  terminatedBy?: string;
  termination?: string;
  drawOfferedBy?: string;
  whiteTimeMs: number;
  blackTimeMs: number;
  incrementMs: number;
  lastMoveAt: number;
  turn: "w" | "b";
  rated: boolean;
  format: keyof typeof TimeFormat;
  timeControl: string;
  tournamentId?: string;
  createdAt: number;
};

function gameKey(gameId: string) {
  return `game:${gameId}`;
}

export function deriveFormat(timeControl: string): keyof typeof TimeFormat {
  const { initialMs } = parseTimeControl(timeControl);
  const minutes = initialMs / 60_000;

  if (minutes <= 2) return "BULLET";
  if (minutes <= 5) return "BLITZ";
  if (minutes <= 15) return "RAPID";
  return "CLASSICAL";
}

export function createGame(params: {
  whiteId: string;
  blackId: string;
  timeControl: string;
  rated: boolean;
  tournamentId?: string;
}): GameState {
  const chess = new Chess();
  const { initialMs, incrementMs } = parseTimeControl(params.timeControl);

  return {
    gameId: uuidv4(),
    white: params.whiteId,
    black: params.blackId,
    fen: chess.fen(),
    pgn: chess.pgn(),
    moves: [],
    status: "ongoing",
    whiteTimeMs: initialMs,
    blackTimeMs: initialMs,
    incrementMs,
    lastMoveAt: Date.now(),
    turn: "w",
    rated: params.rated,
    format: deriveFormat(params.timeControl),
    timeControl: params.timeControl,
    tournamentId: params.tournamentId,
    createdAt: Date.now(),
  };
}

/**
 * The persisted columns this normaliser reads. Structural on purpose, so a caller's
 * `include` shape is irrelevant — only that it selected these.
 */
export type PersistedGameRow = {
  id: string;
  whiteUserId: string | null;
  blackUserId: string | null;
  pgn: string;
  fen: string | null;
  moves: string[];
  timeControl: string | null;
  timeFormat: keyof typeof TimeFormat;
  result: GameResult;
  termination: string | null;
  rated: boolean;
  whiteTimeMs: number | null;
  blackTimeMs: number | null;
  incrementMs: number | null;
  lastMoveAt: Date | null;
  tournamentId: string | null;
  createdAt: Date;
};

/**
 * Turn a finished game's database row into the `GameState` the room renders from.
 *
 * The two shapes are NOT interchangeable and never were: the row calls the players
 * `whiteUserId`/`blackUserId`, has no `status` or `turn` at all, and stores `result` as
 * the `GameResult` enum rather than the client's `"white" | "black" | "draw"`. The game
 * page used to bridge that with `dbGame as unknown as GameState`, and the double cast
 * silenced every mismatch: `game.white` arrived `undefined`, so `isPlayer` was false and
 * BOTH real players were shown "Spectating", Black got a white-oriented board, and the
 * result modal never rendered because `status` was undefined too.
 *
 * It could not self-heal either — a false `isPlayer` makes the client emit
 * `game:spectate`, the server finds nothing in Redis (which is exactly why the page fell
 * back to Postgres) and answers `game:error`, which had no listener.
 *
 * Redis drops a game five minutes after it ends, so this was every game reopened from the
 * history list, not an edge case. Map the row explicitly, and let the compiler hold the
 * two shapes together from here on.
 */
export function gameStateFromDbRow(row: PersistedGameRow): GameState {
  // A deleted user leaves a null id (the relation is SetNull). Empty string is right:
  // it is a string, and it can never equal a real user id, so nobody is mistaken for them.
  const white = row.whiteUserId ?? "";
  const black = row.blackUserId ?? "";

  const fen = (() => {
    if (row.fen) return row.fen;
    // Older rows can lack a FEN. Replay the PGN rather than showing the start position.
    try {
      const chess = new Chess();
      chess.loadPgn(row.pgn);
      return chess.fen();
    } catch {
      return new Chess().fen();
    }
  })();

  const sideToMove = fen.split(" ")[1];

  return {
    gameId: row.id,
    white,
    black,
    fen,
    pgn: row.pgn,
    moves: row.moves,
    // A persisted row is by definition no longer in play.
    status: row.result === "ABORT" ? "aborted" : "finished",
    result:
      row.result === "WHITE_WIN" ? "white" : row.result === "BLACK_WIN" ? "black" : row.result === "DRAW" ? "draw" : undefined,
    termination: row.termination ?? undefined,
    whiteTimeMs: row.whiteTimeMs ?? 0,
    blackTimeMs: row.blackTimeMs ?? 0,
    incrementMs: row.incrementMs ?? 0,
    lastMoveAt: (row.lastMoveAt ?? row.createdAt).getTime(),
    turn: sideToMove === "b" ? "b" : "w",
    rated: row.rated,
    format: row.timeFormat,
    timeControl: row.timeControl ?? "",
    tournamentId: row.tournamentId ?? undefined,
    createdAt: row.createdAt.getTime(),
  };
}

export async function saveGameToRedis(gameState: GameState): Promise<void> {
  await redis.set(gameKey(gameState.gameId), JSON.stringify(gameState), { ex: 86_400 });
}

export async function getGameFromRedis(gameId: string): Promise<GameState | null> {
  const stored = await redis.get<string | GameState>(gameKey(gameId));

  if (!stored) {
    return null;
  }

  return typeof stored === "string" ? (JSON.parse(stored) as GameState) : stored;
}

export function validateMove(
  fen: string,
  from: string,
  to: string,
  promotion?: string,
): {
  valid: boolean;
  newFen?: string;
  san?: string;
  isCheck?: boolean;
  isCheckmate?: boolean;
  isStalemate?: boolean;
  isDraw?: boolean;
} {
  try {
    const chess = new Chess(fen);
    const move = chess.move({ from, to, promotion });

    if (!move) {
      return { valid: false };
    }

    return {
      valid: true,
      newFen: chess.fen(),
      san: move.san,
      isCheck: chess.isCheck(),
      isCheckmate: chess.isCheckmate(),
      isStalemate: chess.isStalemate(),
      isDraw: chess.isDraw(),
    };
  } catch {
    return { valid: false };
  }
}

export function calculateTimeAfterMove(
  gameState: GameState,
  moverId: string,
): { whiteTimeMs: number; blackTimeMs: number } {
  return calculateClockAfterMove(gameState, moverId);
}

function toDbResult(gameState: GameState) {
  if (gameState.status === "aborted") return GameResult.ABORT;
  if (gameState.result === "white") return GameResult.WHITE_WIN;
  if (gameState.result === "black") return GameResult.BLACK_WIN;
  return GameResult.DRAW;
}

export async function finalizeGame(gameState: GameState, io: Server): Promise<void> {
  const finalState: GameState = { ...gameState, status: "finished" };
  await saveGameToRedis(finalState);

  const existingRatings = await db.rating.findMany({
    where: {
      userId: { in: [finalState.white, finalState.black] },
      format: finalState.format as TimeFormat,
    },
  });
  const ratingBefore = new Map(existingRatings.map((rating) => [rating.userId, rating.rating]));

  if (finalState.rated && finalState.result) {
    if (finalState.result === "draw") {
      await updateRatings({
        winnerId: null,
        loserId: null,
        drawPlayerIds: [finalState.white, finalState.black],
        format: finalState.format as TimeFormat,
        db,
      });
    } else {
      await updateRatings({
        winnerId: finalState.result === "white" ? finalState.white : finalState.black,
        loserId: finalState.result === "white" ? finalState.black : finalState.white,
        format: finalState.format as TimeFormat,
        db,
      });
    }
  }

  const ratingsAfter = await db.rating.findMany({
    where: {
      userId: { in: [finalState.white, finalState.black] },
      format: finalState.format as TimeFormat,
    },
  });
  const ratingAfter = new Map(ratingsAfter.map((rating) => [rating.userId, rating.rating]));
  const result = toDbResult(finalState);

  await db.game.create({
    data: {
      id: finalState.gameId,
      whiteUserId: finalState.white,
      blackUserId: finalState.black,
      pgn: finalState.pgn,
      fen: finalState.fen,
      moves: finalState.moves,
      timeControl: finalState.timeControl,
      timeFormat: finalState.format as TimeFormat,
      result,
      termination: finalState.terminatedBy,
      rated: finalState.rated,
      whiteTimeMs: finalState.whiteTimeMs,
      blackTimeMs: finalState.blackTimeMs,
      incrementMs: finalState.incrementMs,
      lastMoveAt: new Date(finalState.lastMoveAt),
      tournamentId: finalState.tournamentId,
      playedAt: new Date(),
      records: {
        create: [
          {
            userId: finalState.white,
            result,
            ratingBefore: ratingBefore.get(finalState.white),
            ratingAfter: ratingAfter.get(finalState.white),
          },
          {
            userId: finalState.black,
            result,
            ratingBefore: ratingBefore.get(finalState.black),
            ratingAfter: ratingAfter.get(finalState.black),
          },
        ],
      },
    },
  });

  io.to(gameKey(finalState.gameId)).emit("game:end", finalState);

  if (finalState.tournamentId) {
    await applyTournamentResult(finalState, io).catch((err) =>
      console.error("Tournament scoring failed:", err));
  }

  setTimeout(() => {
    redis.del(gameKey(finalState.gameId)).catch(err =>
      console.error("Failed to clean up game from Redis:", err));
  }, 5 * 60_000);
}
