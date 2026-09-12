import type { Server, Socket } from "socket.io";
import { TimeFormat } from "@prisma/client";
import { v4 as uuidv4 } from "uuid";
import { db } from "../../db.ts";
import { redis } from "../../redis.ts";
import { createGame, deriveFormat, saveGameToRedis, type GameState } from "../gameEngine.ts";
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

function assignColors(creatorId: string, accepterId: string, color: Challenge["color"]) {
  if (color === "white") return { whiteId: creatorId, blackId: accepterId };
  if (color === "black") return { whiteId: accepterId, blackId: creatorId };
  return Math.random() > 0.5
    ? { whiteId: creatorId, blackId: accepterId }
    : { whiteId: accepterId, blackId: creatorId };
}

/**
 * Put BOTH players in the game and tell EVERY socket they have.
 *
 * This used to resolve a single socket id per player out of `connectedUsers`
 * and emit only to that one. But `connectedUsers` is keyed by socket id, so a
 * player with two sockets — two tabs, a phone and a laptop, or a reconnect
 * whose old entry has not been swept yet — has two entries, and the lookup
 * returns whichever connected FIRST. Measured in production: shiv accepted a
 * challenge, the creator was moved into the game, and the accepter was left
 * sitting in the lobby, because `lobby:game-ready` had been delivered to
 * shiv's other socket.
 *
 * Every socket joins `user:<id>` at connection time, so addressing that room
 * reaches all of a player's sockets and needs no map at all. `socketsJoin`
 * likewise moves all of them into the game room, so a second tab still
 * receives the live game rather than sitting inert.
 */
async function emitGameReady(io: Server, game: GameState) {
  const room = `game:${game.gameId}`;

  for (const userId of [game.white, game.black]) {
    const userRoom = `user:${userId}`;
    io.in(userRoom).socketsJoin(room);
    io.to(userRoom).emit("lobby:game-ready", { gameId: game.gameId });
  }
}

async function getRating(userId: string, format: keyof typeof TimeFormat) {
  const rating = await db.rating.findUnique({
    where: { userId_format: { userId, format } },
    select: { rating: true },
  });

  return rating?.rating ?? 1500;
}

export function setupLobbyHandlers(io: Server, socket: Socket) {
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
    await emitGameReady(io, game);
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
    await emitGameReady(io, game);
  });

  socket.on("lobby:cancel-quick-pair", async (rawPayload: unknown) => {
    const parsed = quickPairSchema.safeParse(rawPayload);
    if (!parsed.success) return socket.emit("lobby:error", { message: "Invalid payload" });
    const payload = parsed.data;

    await redis.zrem(queueKey(deriveFormat(payload.timeControl)), socket.data.userId as string);
  });
}
