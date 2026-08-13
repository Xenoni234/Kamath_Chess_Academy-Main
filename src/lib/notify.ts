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
