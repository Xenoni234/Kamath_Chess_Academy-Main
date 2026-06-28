import type { Server } from "socket.io";
import { Chess } from "chess.js";
import { GameResult, TimeFormat } from "@prisma/client";
import { v4 as uuidv4 } from "uuid";
import { db } from "../db.ts";
import { redis } from "../redis.ts";
import { calculateTimeAfterMove as calculateClockAfterMove, parseTimeControl } from "./clockManager.ts";
import { updateRatings } from "./ratingEngine.ts";

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
  setTimeout(() => {
    void redis.del(gameKey(finalState.gameId));
  }, 5 * 60_000);
}
