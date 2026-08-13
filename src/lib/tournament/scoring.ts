import type { Server } from "socket.io";
import { db } from "../db.ts";
import type { GameState } from "../socket/gameEngine.ts";

/**
 * Recompute a tournament's standings and push them to everyone watching the
 * `tournament:<id>` room. Called after each result and after each new round.
 */
export async function broadcastStandings(tournamentId: string, io: Server): Promise<void> {
  const players = await db.tournamentPlayer.findMany({
    where: { tournamentId },
    orderBy: [{ score: "desc" }, { joinedAt: "asc" }],
    include: { user: { select: { username: true } } },
  });
  io.to(`tournament:${tournamentId}`).emit("tournament:leaderboard", {
    tournamentId,
    standings: players.map((p, i) => ({ rank: i + 1, username: p.user.username, score: p.score })),
  });
}

/**
 * Apply a finished tournament game to the players' scores (win=1, draw=0.5),
 * then broadcast the updated leaderboard. Invoked from gameEngine.finalizeGame
 * whenever the finished game carries a `tournamentId`.
 */
export async function applyTournamentResult(game: GameState, io: Server): Promise<void> {
  const tournamentId = game.tournamentId;
  if (!tournamentId) return;

  const inc = (userId: string, points: number) =>
    db.tournamentPlayer.updateMany({
      where: { tournamentId, userId },
      data: { score: { increment: points } },
    });

  if (game.result === "draw") {
    await Promise.all([inc(game.white, 0.5), inc(game.black, 0.5)]);
  } else if (game.result === "white") {
    await inc(game.white, 1);
  } else if (game.result === "black") {
    await inc(game.black, 1);
  }

  await broadcastStandings(tournamentId, io);
}
