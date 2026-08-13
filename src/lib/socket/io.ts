import type { Server } from "socket.io";

/**
 * Cross-context accessor for the Socket.io server. The socket server (raw Node,
 * via server.mjs) and the Next app run in the same process but are bundled
 * separately, so they do not share module singletons. A process-global keyed by
 * a registered Symbol bridges them, letting API routes emit to a user's live
 * sockets (each socket joins the room `user:<userId>` on connect).
 */
const IO_KEY = Symbol.for("kca.socket.io");

export function setIo(io: Server): void {
  (globalThis as Record<symbol, unknown>)[IO_KEY] = io;
}

export function getIo(): Server | null {
  return ((globalThis as Record<symbol, unknown>)[IO_KEY] as Server | undefined) ?? null;
}
