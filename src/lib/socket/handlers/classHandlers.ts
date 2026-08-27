import type { Server, Socket } from "socket.io";
import { db } from "../../db.ts";
import { classJoinSchema, classMessageSchema } from "../../validations/socket.ts";

/**
 * Live class room (Phase 6 v1).
 *
 * In-class chat + roster over the existing authenticated Socket.io connection.
 * Video is handled client-side (embedded Jitsi / the class's meetingUrl); this
 * layer only carries chat, presence, and — in v2 — the mediasoup signalling.
 *
 * Access is gated at join: you must be the class's coach or enrolled in it (or
 * its batch). After that, room membership is the gate for sending — a socket that
 * never joined cannot post to the room.
 */

function room(classId: string) {
  return `class:${classId}`;
}

/** Is this user the class's coach, or enrolled in the class/its batch? */
async function canAccess(classId: string, userId: string): Promise<boolean> {
  const cls = await db.class.findUnique({
    where: { id: classId },
    select: { batchId: true, coach: { select: { userId: true } } },
  });
  if (!cls) return false;
  if (cls.coach?.userId === userId) return true;
  const enrolled = await db.classEnrollment.findFirst({
    where: {
      userId,
      OR: [{ classId }, ...(cls.batchId ? [{ batchId: cls.batchId }] : [])],
    },
    select: { id: true },
  });
  return Boolean(enrolled);
}

/** Recompute and broadcast the room's roster (deduped by user). */
async function emitRoster(io: Server, classId: string) {
  const sockets = await io.in(room(classId)).fetchSockets();
  const seen = new Map<string, string>();
  for (const s of sockets) {
    const uid = s.data.userId as string | undefined;
    if (uid) seen.set(uid, (s.data.username as string) ?? "student");
  }
  io.to(room(classId)).emit(
    "class:roster",
    Array.from(seen, ([userId, username]) => ({ userId, username })),
  );
}

export function setupClassHandlers(io: Server, socket: Socket) {
  const joined = new Set<string>();

  socket.on("class:join", async (raw: unknown) => {
    const parsed = classJoinSchema.safeParse(raw);
    if (!parsed.success) return;
    const { classId } = parsed.data;
    if (!(await canAccess(classId, socket.data.userId))) {
      socket.emit("class:error", { message: "You are not part of this class." });
      return;
    }
    socket.join(room(classId));
    joined.add(classId);
    await emitRoster(io, classId);
  });

  socket.on("class:leave", async (raw: unknown) => {
    const parsed = classJoinSchema.safeParse(raw);
    if (!parsed.success) return;
    socket.leave(room(parsed.data.classId));
    joined.delete(parsed.data.classId);
    await emitRoster(io, parsed.data.classId);
  });

  socket.on("class:message", async (raw: unknown) => {
    const parsed = classMessageSchema.safeParse(raw);
    if (!parsed.success) return;
    const { classId, body } = parsed.data;
    // Must have joined this room — access was authorized there.
    if (!socket.rooms.has(room(classId))) return;

    const msg = await db.message.create({
      data: { classId, userId: socket.data.userId, body },
      select: { id: true, createdAt: true },
    });
    io.to(room(classId)).emit("class:message", {
      id: msg.id,
      classId,
      userId: socket.data.userId,
      username: socket.data.username ?? "student",
      body,
      createdAt: msg.createdAt,
    });
  });

  socket.on("disconnect", () => {
    for (const classId of joined) void emitRoster(io, classId);
  });
}
