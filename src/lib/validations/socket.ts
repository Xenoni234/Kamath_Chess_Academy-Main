import { z } from "zod";

export const gameMoveSchema = z.object({
  gameId: z.string(),
  from: z.string().length(2),
  to: z.string().length(2),
  promotion: z.string().optional(),
});

export const gameIdSchema = z.object({ gameId: z.string() });

export const createChallengeSchema = z.object({
  timeControl: z.string(),
  color: z.enum(["white", "black", "random"]),
  rated: z.boolean(),
});

export const challengeIdSchema = z.object({ challengeId: z.string() });

export const quickPairSchema = z.object({ timeControl: z.string() });

export const tournamentWatchSchema = z.object({ tournamentId: z.string() });

/** Join/leave a live class room (Phase 6 v1). */
export const classJoinSchema = z.object({ classId: z.string().min(1) });

/** An in-class chat message. */
export const classMessageSchema = z.object({
  classId: z.string().min(1),
  body: z.string().trim().min(1).max(2000),
});
