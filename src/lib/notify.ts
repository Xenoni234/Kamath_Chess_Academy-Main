import type { NotificationType } from "@prisma/client";
import { db } from "./db";
import { getIo } from "./socket/io";

/**
 * Persist a notification and, when the socket server is up, push it live to the
 * recipient's sockets (`user:<userId>` room). Every Phase 3 track (scheduling,
 * payments, tournaments) calls this. Safe to call from any API route.
 */
export async function createNotification(params: {
  userId: string;
  type: NotificationType;
  title: string;
  body: string;
}) {
  const notification = await db.notification.create({ data: params });
  getIo()?.to(`user:${params.userId}`).emit("notification:new", notification);
  return notification;
}

/**
 * Same contract as `createNotification` but for a whole cohort, in ONE insert.
 * Fanning out to a class of students previously issued one round trip each,
 * which is expensive when the database is a region away. Returns the created
 * rows so each recipient still gets its live socket push.
 */
export async function createNotifications(
  entries: { userId: string; type: NotificationType; title: string; body: string }[],
) {
  if (entries.length === 0) return [];
  const notifications = await db.notification.createManyAndReturn({ data: entries });
  const io = getIo();
  if (io) {
    for (const notification of notifications) {
      io.to(`user:${notification.userId}`).emit("notification:new", notification);
    }
  }
  return notifications;
}
