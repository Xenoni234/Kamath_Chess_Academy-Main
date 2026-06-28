import type { Server, Socket } from "socket.io";
import { db } from "../../db.ts";
import type { ConnectedUsers } from "../server.ts";

export async function setupPresenceHandlers(io: Server, socket: Socket, connectedUsers: ConnectedUsers) {
  const userId = socket.data.userId as string;
  connectedUsers.set(socket.id, userId);

  io.emit("presence:online-count", new Set(connectedUsers.values()).size);

  const onlineUserIds = Array.from(new Set(connectedUsers.values()));
  socket.emit("presence:online-users", onlineUserIds);

  const user = await db.user.findUnique({
    where: { id: userId },
    select: { username: true },
  });

  io.emit("presence:user-online", {
    userId,
    username: user?.username ?? socket.data.username ?? "Unknown",
  });

  socket.on("disconnect", () => {
    connectedUsers.delete(socket.id);
    io.emit("presence:user-offline", { userId });
  });
}
