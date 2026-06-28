import type { Server, Socket } from "socket.io";
import { Chess } from "chess.js";
import { redis } from "../../redis.ts";
import {
  calculateTimeAfterMove,
  finalizeGame,
  getGameFromRedis,
  saveGameToRedis,
  validateMove,
  type GameState,
} from "../gameEngine.ts";

function room(gameId: string) {
  return `game:${gameId}`;
}

function isPlayer(game: GameState, userId: string) {
  return game.white === userId || game.black === userId;
}

function expectedMover(game: GameState) {
  return game.turn === "w" ? game.white : game.black;
}

function opponent(game: GameState, userId: string) {
  return userId === game.white ? game.black : game.white;
}

function resultForWinner(game: GameState, winnerId: string): "white" | "black" {
  return winnerId === game.white ? "white" : "black";
}

async function endAbortedGame(game: GameState, io: Server) {
  const finalState: GameState = { ...game, status: "aborted", terminatedBy: "abort" };
  await saveGameToRedis(finalState);
  io.to(room(game.gameId)).emit("game:end", finalState);
  setTimeout(() => {
    void redis.del(room(game.gameId));
  }, 5 * 60_000);
}

export function setupGameHandlers(io: Server, socket: Socket) {
  socket.on("game:join", async (payload: { gameId: string }) => {
    const game = await getGameFromRedis(payload.gameId);
    const userId = socket.data.userId as string;

    if (!game || !isPlayer(game, userId)) {
      socket.emit("game:error", { message: "Game not found or access denied." });
      return;
    }

    socket.join(room(game.gameId));
    socket.emit("game:state", game);
  });

  socket.on("game:spectate", async (payload: { gameId: string }) => {
    const game = await getGameFromRedis(payload.gameId);

    if (!game) {
      socket.emit("game:error", { message: "Game not found." });
      return;
    }

    socket.join(room(game.gameId));
    socket.emit("game:state", { ...game, spectator: true });
  });

  socket.on("game:move", async (payload: { gameId: string; from: string; to: string; promotion?: string }) => {
    const game = await getGameFromRedis(payload.gameId);
    const userId = socket.data.userId as string;

    if (!game || game.status !== "ongoing" || !isPlayer(game, userId) || expectedMover(game) !== userId) {
      socket.emit("game:move-invalid", { message: "Not your turn." });
      return;
    }

    const clocks = calculateTimeAfterMove(game, userId);
    const moverTime = userId === game.white ? clocks.whiteTimeMs : clocks.blackTimeMs;

    if (moverTime <= 0) {
      await finalizeGame(
        {
          ...game,
          ...clocks,
          result: resultForWinner(game, opponent(game, userId)),
          terminatedBy: "timeout",
        },
        io,
      );
      return;
    }

    const validation = validateMove(game.fen, payload.from, payload.to, payload.promotion);

    if (!validation.valid || !validation.newFen || !validation.san) {
      socket.emit("game:move-invalid", { message: "Illegal move." });
      return;
    }

    const chess = new Chess(game.fen);
    chess.move({ from: payload.from, to: payload.to, promotion: payload.promotion });
    const nextGame: GameState = {
      ...game,
      ...clocks,
      fen: validation.newFen,
      pgn: chess.pgn(),
      moves: [...game.moves, `${payload.from}${payload.to}${payload.promotion ?? ""}`],
      turn: game.turn === "w" ? "b" : "w",
      lastMoveAt: Date.now(),
    };

    if (validation.isCheckmate) {
      await finalizeGame(
        {
          ...nextGame,
          result: resultForWinner(nextGame, userId),
          terminatedBy: "checkmate",
        },
        io,
      );
      return;
    }

    if (validation.isStalemate || validation.isDraw) {
      await finalizeGame(
        {
          ...nextGame,
          result: "draw",
          terminatedBy: validation.isStalemate ? "stalemate" : "insufficient",
        },
        io,
      );
      return;
    }

    await saveGameToRedis(nextGame);
    io.to(room(game.gameId)).emit("game:update", nextGame);
  });

  socket.on("game:resign", async (payload: { gameId: string }) => {
    const game = await getGameFromRedis(payload.gameId);
    const userId = socket.data.userId as string;

    if (!game || !isPlayer(game, userId)) return;

    await finalizeGame(
      {
        ...game,
        result: resultForWinner(game, opponent(game, userId)),
        terminatedBy: "resign",
      },
      io,
    );
  });

  socket.on("game:draw-offer", async (payload: { gameId: string }) => {
    const game = await getGameFromRedis(payload.gameId);
    const userId = socket.data.userId as string;
    if (!game || !isPlayer(game, userId)) return;

    socket.to(room(game.gameId)).emit("game:draw-offered", { gameId: game.gameId, offeredBy: userId });
  });

  socket.on("game:draw-accept", async (payload: { gameId: string }) => {
    const game = await getGameFromRedis(payload.gameId);
    const userId = socket.data.userId as string;
    if (!game || !isPlayer(game, userId)) return;

    await finalizeGame({ ...game, result: "draw", terminatedBy: "draw-agreement" }, io);
  });

  socket.on("game:draw-decline", async (payload: { gameId: string }) => {
    const game = await getGameFromRedis(payload.gameId);
    const userId = socket.data.userId as string;
    if (!game || !isPlayer(game, userId)) return;

    socket.to(room(game.gameId)).emit("game:draw-declined", { gameId: game.gameId, declinedBy: userId });
  });

  socket.on("game:abort", async (payload: { gameId: string }) => {
    const game = await getGameFromRedis(payload.gameId);
    const userId = socket.data.userId as string;
    if (!game || !isPlayer(game, userId)) return;

    if (game.moves.length >= 4) {
      socket.emit("game:error", { message: "Game can no longer be aborted." });
      return;
    }

    await endAbortedGame(game, io);
  });
}
