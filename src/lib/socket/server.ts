import type { Server, Socket } from "socket.io";
import { verifyAccessToken } from "../auth.ts";
import { setIo } from "./io.ts";
import { setupGameHandlers } from "./handlers/gameHandlers.ts";
import { setupLobbyHandlers } from "./handlers/lobbyHandlers.ts";
import { setupPresenceHandlers } from "./handlers/presenceHandlers.ts";

export type ConnectedUsers = Map<string, string>;

function getCookie(cookieHeader: string | undefined, name: string) {
  if (!cookieHeader) {
    return null;
  }

  for (const cookie of cookieHeader.split(";")) {
    const [rawKey, ...rawValue] = cookie.trim().split("=");
    if (rawKey === name) {
      return decodeURIComponent(rawValue.join("="));
    }
  }

  return null;
}

function authenticateSocket(socket: Socket) {
  const token = getCookie(socket.handshake.headers.cookie, "kca_access_token");

  if (!token) {
    return null;
  }

  try {
    return verifyAccessToken(token);
  } catch {
    return null;
  }
}

export function setupSocketServer(io: Server) {
  const connectedUsers: ConnectedUsers = new Map();

  // Expose the io instance to API routes (notifications, tournaments) so they
  // can emit to a user's sockets via the `user:<userId>` room.
  setIo(io);

  // Upstash Redis is REST-based. The Socket.io Redis adapter expects pub/sub
  // clients such as ioredis, so Phase 1 intentionally uses the in-memory
  // adapter. Add the Redis adapter in Phase 3 when horizontal scaling is needed.
  io.on("connection", (socket) => {
    const payload = authenticateSocket(socket);

    if (!payload?.userId) {
      socket.disconnect(true);
      return;
    }

    socket.data.userId = payload.userId;
    socket.data.username = payload.username;

    // Personal room for direct server→user emits (notifications, etc.).
    socket.join(`user:${payload.userId}`);

    setupPresenceHandlers(io, socket, connectedUsers);
    setupLobbyHandlers(io, socket, connectedUsers);
    setupGameHandlers(io, socket);

    socket.on("disconnect", () => {
      connectedUsers.delete(socket.id);
      io.emit("presence:online-count", new Set(connectedUsers.values()).size);
      io.emit("presence:online-users", Array.from(new Set(connectedUsers.values())));
    });
  });
}
