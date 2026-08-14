import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { verifyAccessToken } from "@/lib/auth";
import { db } from "@/lib/db";
import { type GameState } from "@/lib/socket/gameEngine";
import { getGameFromRedis } from "@/lib/socket/gameEngine";
import GameRoomClient from "./GameRoomClient";

export default async function GameRoomPage(context: { params: Promise<{ gameId: string }> }) {
  const { gameId } = await context.params;
  const cookieStore = await cookies();
  const token = cookieStore.get("kca_access_token")?.value;

  if (!token) {
    redirect("/login");
  }

  let payload;
  try {
    payload = verifyAccessToken(token);
  } catch {
    redirect("/login");
  }

  const userId = payload.userId;
  const username = payload.username;
  const role = payload.role;

  // 1. Fetch game from Redis first
  const activeGame = await getGameFromRedis(gameId);
  let isFinished = false;
  let dbGame = null;

  if (!activeGame) {
    // 2. Fall back to Postgres DB
    dbGame = await db.game.findUnique({
      where: { id: gameId },
      include: {
        whiteUser: { select: { id: true, username: true } },
        blackUser: { select: { id: true, username: true } },
        records: true,
      },
    });

    if (!dbGame) {
      redirect("/dashboard/play");
    }
    isFinished = true;
  }

  const whiteId = activeGame ? activeGame.white : dbGame!.whiteUserId!;
  const blackId = activeGame ? activeGame.black : dbGame!.blackUserId!;
  const format = activeGame ? activeGame.format : dbGame!.timeFormat;

  // 3. Load player ratings and details
  const [whiteUser, blackUser] = await Promise.all([
    db.user.findUnique({
      where: { id: whiteId },
      select: {
        id: true,
        username: true,
        ratings: {
          where: { format },
          select: { rating: true },
        },
      },
    }),
    db.user.findUnique({
      where: { id: blackId },
      select: {
        id: true,
        username: true,
        ratings: {
          where: { format },
          select: { rating: true },
        },
      },
    }),
  ]);

  const initialWhiteUsername = whiteUser?.username ?? "White Player";
  const initialWhiteRating = whiteUser?.ratings[0]?.rating ?? 1500;
  const initialBlackUsername = blackUser?.username ?? "Black Player";
  const initialBlackRating = blackUser?.ratings[0]?.rating ?? 1500;

  return (
    <GameRoomClient
      gameId={gameId}
      userId={userId}
      username={username}
      role={role}
      activeGame={activeGame}
      dbGame={dbGame as unknown as GameState}
      isFinished={isFinished}
      initialPlayers={{
        white: { username: initialWhiteUsername, rating: initialWhiteRating },
        black: { username: initialBlackUsername, rating: initialBlackRating },
      }}
    />
  );
}
