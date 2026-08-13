import { redis } from "@/lib/redis";
import { db } from "@/lib/db";
import { createGame, saveGameToRedis, getGameFromRedis } from "@/lib/socket/gameEngine";
import { getIo } from "@/lib/socket/io";
import { createNotification } from "@/lib/notify";
import { roundRobinSchedule } from "./roundRobin";
import { swissPairings, type SwissPlayer } from "./swiss";
import { arenaPairings, type ArenaPlayer } from "./arena";
import { broadcastStandings } from "./scoring";
import { isBye, type Pairing } from "./types";

const DEFAULT_TC = "5+0";

type TState = {
  round: number;
  totalRounds?: number; // set for SWISS/ROUND_ROBIN; absent = open-ended (ARENA)
  rrSchedule?: Pairing[][];
  byes: string[];
  activeGameIds: string[];
};

function stateKey(id: string) {
  return `tournament:state:${id}`;
}
async function getState(id: string): Promise<TState | null> {
  const raw = await redis.get<string | TState>(stateKey(id));
  if (!raw) return null;
  return typeof raw === "string" ? (JSON.parse(raw) as TState) : raw;
}
async function setState(id: string, state: TState) {
  await redis.set(stateKey(id), JSON.stringify(state), { ex: 86_400 });
}

type Result = { ok: boolean; message?: string; finished?: boolean; roundInProgress?: boolean };

/** Create the games for a round, award byes, and notify players. */
async function materializeRound(tournamentId: string, pairings: Pairing[]): Promise<string[]> {
  const io = getIo();
  const gameIds: string[] = [];

  for (const pairing of pairings) {
    if (isBye(pairing)) {
      await db.tournamentPlayer.updateMany({
        where: { tournamentId, userId: pairing.byeId },
        data: { score: { increment: 1 } },
      });
      await createNotification({
        userId: pairing.byeId,
        type: "TOURNAMENT_STARTING",
        title: "Round bye",
        body: "You have a bye this round (+1 point).",
      });
      continue;
    }

    const game = createGame({
      whiteId: pairing.whiteId,
      blackId: pairing.blackId,
      timeControl: DEFAULT_TC,
      rated: false,
      tournamentId,
    });
    await saveGameToRedis(game);
    gameIds.push(game.gameId);

    for (const userId of [pairing.whiteId, pairing.blackId]) {
      io?.to(`user:${userId}`).emit("tournament:pairing", { tournamentId, gameId: game.gameId });
    }
  }

  return gameIds;
}

/** Reconstruct Swiss history (opponents, colours, byes) from finished games. */
async function buildSwissPlayers(tournamentId: string, byes: string[]): Promise<SwissPlayer[]> {
  const [players, games] = await Promise.all([
    db.tournamentPlayer.findMany({ where: { tournamentId }, select: { userId: true, score: true } }),
    db.game.findMany({ where: { tournamentId }, select: { whiteUserId: true, blackUserId: true } }),
  ]);

  const opponents: Record<string, string[]> = {};
  const white: Record<string, number> = {};
  const black: Record<string, number> = {};
  for (const g of games) {
    const w = g.whiteUserId;
    const b = g.blackUserId;
    if (!w || !b) continue;
    (opponents[w] ??= []).push(b);
    (opponents[b] ??= []).push(w);
    white[w] = (white[w] ?? 0) + 1;
    black[b] = (black[b] ?? 0) + 1;
  }

  return players.map((p) => ({
    userId: p.userId,
    score: p.score,
    opponents: opponents[p.userId] ?? [],
    whiteCount: white[p.userId] ?? 0,
    blackCount: black[p.userId] ?? 0,
    hadBye: byes.includes(p.userId),
  }));
}

export async function startTournament(tournamentId: string): Promise<Result> {
  const tournament = await db.tournament.findUnique({ where: { id: tournamentId }, select: { type: true, status: true } });
  if (!tournament) return { ok: false, message: "Tournament not found" };
  if (tournament.status !== "UPCOMING") return { ok: false, message: "Tournament already started" };

  const players = await db.tournamentPlayer.findMany({ where: { tournamentId }, select: { userId: true } });
  const ids = players.map((p) => p.userId);
  if (ids.length < 2) return { ok: false, message: "Need at least 2 players to start" };

  let pairings: Pairing[];
  const state: TState = { round: 1, byes: [], activeGameIds: [] };

  if (tournament.type === "ROUND_ROBIN") {
    const schedule = roundRobinSchedule(ids);
    state.rrSchedule = schedule;
    state.totalRounds = schedule.length;
    pairings = schedule[0] ?? [];
  } else if (tournament.type === "SWISS") {
    state.totalRounds = Math.min(9, Math.max(3, Math.ceil(Math.log2(ids.length))));
    pairings = swissPairings(ids.map((id) => ({ userId: id, score: 0, opponents: [], whiteCount: 0, blackCount: 0, hadBye: false })));
  } else {
    // ARENA — open-ended; HR ends it.
    pairings = arenaPairings(ids.map((id) => ({ userId: id, score: 0 }))).pairings;
  }

  state.byes = pairings.filter(isBye).map((p) => (p as { byeId: string }).byeId);
  state.activeGameIds = await materializeRound(tournamentId, pairings);
  await setState(tournamentId, state);
  await db.tournament.update({ where: { id: tournamentId }, data: { status: "ONGOING" } });

  const io = getIo();
  if (io) {
    await broadcastStandings(tournamentId, io);
    io.to(`tournament:${tournamentId}`).emit("tournament:round", { tournamentId, round: state.round });
  }
  return { ok: true };
}

export async function advanceRound(tournamentId: string): Promise<Result> {
  const tournament = await db.tournament.findUnique({ where: { id: tournamentId }, select: { type: true, status: true } });
  if (!tournament) return { ok: false, message: "Tournament not found" };
  if (tournament.status !== "ONGOING") return { ok: false, message: "Tournament is not running" };

  const state = await getState(tournamentId);
  if (!state) return { ok: false, message: "Tournament state missing — restart it" };

  // The round is only complete once every game of it has finished.
  const games = await Promise.all(state.activeGameIds.map((id) => getGameFromRedis(id)));
  const stillPlaying = games.some((g) => g && g.status === "ongoing");
  if (stillPlaying) return { ok: false, roundInProgress: true, message: "Round still in progress" };

  // Round-limited formats finish when the schedule is exhausted.
  if (tournament.type !== "ARENA" && state.totalRounds && state.round >= state.totalRounds) {
    await finishTournament(tournamentId);
    return { ok: true, finished: true };
  }

  let pairings: Pairing[];
  if (tournament.type === "ROUND_ROBIN") {
    pairings = state.rrSchedule?.[state.round] ?? [];
    if (pairings.length === 0) {
      await finishTournament(tournamentId);
      return { ok: true, finished: true };
    }
  } else if (tournament.type === "SWISS") {
    pairings = swissPairings(await buildSwissPlayers(tournamentId, state.byes));
  } else {
    const players = await db.tournamentPlayer.findMany({ where: { tournamentId }, select: { userId: true, score: true } });
    const pool: ArenaPlayer[] = players.map((p) => ({ userId: p.userId, score: p.score }));
    pairings = arenaPairings(pool).pairings;
  }

  const newByes = pairings.filter(isBye).map((p) => (p as { byeId: string }).byeId);
  const activeGameIds = await materializeRound(tournamentId, pairings);
  await setState(tournamentId, {
    ...state,
    round: state.round + 1,
    byes: [...state.byes, ...newByes],
    activeGameIds,
  });

  const io = getIo();
  if (io) {
    await broadcastStandings(tournamentId, io);
    io.to(`tournament:${tournamentId}`).emit("tournament:round", { tournamentId, round: state.round + 1 });
  }
  return { ok: true };
}

export async function finishTournament(tournamentId: string): Promise<void> {
  // Freeze final ranks by score.
  const players = await db.tournamentPlayer.findMany({
    where: { tournamentId },
    orderBy: [{ score: "desc" }, { joinedAt: "asc" }],
    select: { id: true },
  });
  await Promise.all(players.map((p, i) => db.tournamentPlayer.update({ where: { id: p.id }, data: { rank: i + 1 } })));
  await db.tournament.update({ where: { id: tournamentId }, data: { status: "FINISHED" } });

  const io = getIo();
  if (io) {
    await broadcastStandings(tournamentId, io);
    io.to(`tournament:${tournamentId}`).emit("tournament:finished", { tournamentId });
  }
}
