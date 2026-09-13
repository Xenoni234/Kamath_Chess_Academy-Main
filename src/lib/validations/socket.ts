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

/**
 * A chat message between the two players of a game.
 *
 * Kept short deliberately. This is a chat between two children mid-game, not a
 * discussion forum, and a shorter cap is one fewer way for it to be misused.
 */
export const gameMessageSchema = z.object({
  gameId: z.string().min(1),
  body: z.string().trim().min(1).max(300),
});

/** An in-class chat message. */
export const classMessageSchema = z.object({
  classId: z.string().min(1),
  body: z.string().trim().min(1).max(2000),
});


/**
 * mediasoup signalling payloads (Phase 6 SFU).
 *
 * These handlers are `async` with no try/catch, so an unvalidated payload that
 * fails to destructure throws inside a promise — an unhandled rejection, which
 * terminates the process serving the entire app. Every other socket handler
 * already validates; these did not.
 *
 * The RTP/DTLS structures are opaque mediasoup types, so they are checked for
 * shape (a non-null object) rather than parsed field by field — mediasoup itself
 * rejects malformed contents, and duplicating its schema here would rot.
 */
const opaqueObject = z.record(z.string(), z.unknown());

export const mediaRoomSchema = z.object({ classId: z.string().min(1).max(64) });

export const mediaTransportSchema = z.object({
  classId: z.string().min(1).max(64),
  direction: z.enum(["send", "recv"]).optional(),
});

export const mediaConnectSchema = z.object({
  classId: z.string().min(1).max(64),
  transportId: z.string().min(1).max(128),
  dtlsParameters: opaqueObject,
});

export const mediaProduceSchema = z.object({
  classId: z.string().min(1).max(64),
  transportId: z.string().min(1).max(128),
  kind: z.enum(["audio", "video"]),
  rtpParameters: opaqueObject,
  appData: opaqueObject.optional(),
});

export const mediaConsumeSchema = z.object({
  classId: z.string().min(1).max(64),
  transportId: z.string().min(1).max(128),
  producerId: z.string().min(1).max(128),
  rtpCapabilities: opaqueObject,
});

export const mediaConsumerSchema = z.object({
  classId: z.string().min(1).max(64),
  consumerId: z.string().min(1).max(128),
});

export const mediaProducerSchema = z.object({
  classId: z.string().min(1).max(64),
  producerId: z.string().min(1).max(128),
});
