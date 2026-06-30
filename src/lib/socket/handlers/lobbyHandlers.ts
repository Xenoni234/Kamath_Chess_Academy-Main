import type { Server, Socket } from "socket.io";
import { TimeFormat } from "@prisma/client";
import { v4 as uuidv4 } from "uuid";
import { db } from "../../db.ts";
import { redis } from "../../redis.ts";
import { createGame, deriveFormat, saveGameToRedis, type GameState } from "../gameEngine.ts";
import type { ConnectedUsers } from "../server.ts";
import { challengeIdSchema, createChallengeSchema, quickPairSchema } from "../../validations/socket.ts";

type Challenge = {
  challengeId: string;
  creatorId: string;
  timeControl: string;
  color: "white" | "black" | "random";
  rated: boolean;
  createdAt: number;
};

const CHALLENGES_KEY = "lobby:challenges";

function queueKey(format: string) {
  return `lobby:queue:${format}`;
}

async function getChallenges() {
  const values = await redis.hgetall<Record<string, string | Challenge>>(CHALLENGES_KEY);
  if (!values) return [];

  return Object.values(values).map((value) => (typeof value === "string" ? (JSON.parse(value) as Challenge) : value));
}

async function broadcastChallenges(io: Server) {
  io.emit("lobby:challenges", await getChallenges());
}

function getSocketIdForUser(connectedUsers: ConnectedUsers, userId: string) {
  for (const [socketId, connectedUserId] of connectedUsers) {
    if (connectedUserId === userId) {
      return socketId;
    }
  }

  return null;
}

function assignColors(creatorId: string, accepterId: string, color: Challenge["color"]) {
  if (color === "white") return { whiteId: creatorId, blackId: accepterId };
  if (color === "black") return { whiteId: accepterId, blackId: creatorId };
  return Math.random() > 0.5
    ? { whiteId: creatorId, blackId: accepterId }
    : { whiteId: accepterId, blackId: creatorId };
}

async function emitGameReady(io: Server, connectedUsers: ConnectedUsers, game: GameState) {
  const room = `game:${game.gameId}`;
  const whiteSocketId = getSocketIdForUser(connectedUsers, game.white);
  const blackSocketId = getSocketIdForUser(connectedUsers, game.black);

  if (whiteSocketId) {
    const whiteSocket = io.sockets.sockets.get(whiteSocketId);
    whiteSocket?.join(room);
    whiteSocket?.emit("lobby:game-ready", { gameId: game.gameId });
  }

  if (blackSocketId) {
    const blackSocket = io.sockets.sockets.get(blackSocketId);
    blackSocket?.join(room);
    blackSocket?.emit("lobby:game-ready", { gameId: game.gameId });
  }
}

async function getRating(userId: string, format: keyof typeof TimeFormat) {
  const rating = await db.rating.findUnique({
    where: { userId_format: { userId, format } },
    select: { rating: true },
  });

  return rating?.rating ?? 1500;
}

export function setupLobbyHandlers(io: Server, socket: Socket, connectedUsers: ConnectedUsers) {
  void getChallenges().then((challenges) => {
    socket.emit("lobby:challenges", challenges);
  }).catch((err) => console.error("Failed to broadcast challenges:", err));

  socket.on("lobby:create-challenge", async (rawPayload: unknown) => {
    const parsed = createChallengeSchema.safeParse(rawPayload);
    if (!parsed.success) return socket.emit("lobby:error", { message: "Invalid payload" });
    const payload = parsed.data;
    
    const challenge: Challenge = {
      challengeId: uuidv4(),
      creatorId: socket.data.userId,
      timeControl: payload.timeControl,
      color: payload.color,
      rated: Boolean(payload.rated),
      createdAt: Date.now(),
    };

    await redis.hset(CHALLENGES_KEY, { [challenge.challengeId]: JSON.stringify(challenge) });
    await broadcastChallenges(io);
  });

  socket.on("lobby:cancel-challenge", async (rawPayload: unknown) => {
    const parsed = challengeIdSchema.safeParse(rawPayload);
    if (!parsed.success) return socket.emit("lobby:error", { message: "Invalid payload" });
    const payload = parsed.data;

    const value = await redis.hget<string | Challenge>(CHALLENGES_KEY, payload.challengeId);
    if (!value) return;
    
    const challenge = typeof value === "string" ? JSON.parse(value) as Challenge : value;
    const userId = socket.data.userId as string;
    
    if (challenge.creatorId !== userId) {
      socket.emit("lobby:error", { message: "You can only cancel your own challenges." });
      return;
    }
    
    await redis.hdel(CHALLENGES_KEY, payload.challengeId);
    await broadcastChallenges(io);
  });

  socket.on("lobby:accept-challenge", async (rawPayload: unknown) => {
    const parsed = challengeIdSchema.safeParse(rawPayload);
    if (!parsed.success) return socket.emit("lobby:error", { message: "Invalid payload" });
    const payload = parsed.data;

    const value = await redis.hget<string | Challenge>(CHALLENGES_KEY, payload.challengeId);
    if (!value) return;

    const challenge = typeof value === "string" ? (JSON.parse(value) as Challenge) : value;
    const accepterId = socket.data.userId as string;

    if (challenge.creatorId === accepterId) {
      socket.emit("lobby:error", { message: "You cannot accept your own challenge." });
      return;
    }

    const colors = assignColors(challenge.creatorId, accepterId, challenge.color);
    const game = createGame({
      ...colors,
      timeControl: challenge.timeControl,
      rated: challenge.rated,
    });

    await saveGameToRedis(game);
    await redis.hdel(CHALLENGES_KEY, challenge.challengeId);
    await emitGameReady(io, connectedUsers, game);
    await broadcastChallenges(io);
  });

  socket.on("lobby:quick-pair", async (rawPayload: unknown) => {
    const parsed = quickPairSchema.safeParse(rawPayload);
    if (!parsed.success) return socket.emit("lobby:error", { message: "Invalid payload" });
    const payload = parsed.data;

    const userId = socket.data.userId as string;
    const format = deriveFormat(payload.timeControl);
    const key = queueKey(format);
    const rating = await getRating(userId, format);
    const candidates = await redis.zrange<string[]>(key, rating - 300, rating + 300, { byScore: true });
    const opponentId = candidates.find((candidateId) => candidateId !== userId);

    if (!opponentId) {
      await redis.zadd(key, { score: rating, member: userId });
      socket.emit("lobby:queued", { timeControl: payload.timeControl, format });
      return;
    }

    await redis.zrem(key, userId, opponentId);
    const isWhite = Math.random() > 0.5;
    const game = createGame({
      whiteId: isWhite ? userId : opponentId,
      blackId: isWhite ? opponentId : userId,
      timeControl: payload.timeControl,
      rated: true,
    });

    await saveGameToRedis(game);
    await emitGameReady(io, connectedUsers, game);
  });

  socket.on("lobby:cancel-quick-pair", async (rawPayload: unknown) => {
    const parsed = quickPairSchema.safeParse(rawPayload);
    if (!parsed.success) return socket.emit("lobby:error", { message: "Invalid payload" });
    const payload = parsed.data;

    await redis.zrem(queueKey(deriveFormat(payload.timeControl)), socket.data.userId as string);
  });
}
