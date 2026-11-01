import type { Server, Socket } from "socket.io";
import { verifyAccessToken } from "../auth.ts";
import { setIo } from "./io.ts";
import { setupGameHandlers } from "./handlers/gameHandlers.ts";
import { setupLobbyHandlers } from "./handlers/lobbyHandlers.ts";
import { setupPresenceHandlers } from "./handlers/presenceHandlers.ts";
import { setupTournamentHandlers } from "./handlers/tournamentHandlers.ts";
import { setupClassHandlers } from "./handlers/classHandlers.ts";
import { setupMediaHandlers } from "./handlers/mediaHandlers.ts";

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

/**
 * Per-connection ceiling on inbound events.
 *
 * There are 23 `socket.on` handlers across the handler modules and, until this, not one of them
 * had any budget: an authenticated user could emit `game:move` or `class:chat` in a loop and
 * every one of those would be processed on the SAME single event loop that the 10 Oct 2026
 * login flood took the platform down through. It ranks below that one because it needs a real
 * account — but a student with a browser console is not a high bar.
 *
 * `socket.use` is socket.io's inbound-packet hook, so this covers all 23 handlers in one place
 * rather than needing a guard added to each — and, more importantly, it covers the next handler
 * someone adds without them having to remember.
 *
 * The budget is per socket and lives in a closure, so it is garbage collected with the
 * connection; there is no map to grow or sweep. 120 events per 10 s is ~12/s sustained, which is
 * far above real play — a blitz game produces a few moves a second at most, and the chat and
 * presence traffic is trivial next to that — and far below anything that can hurt the loop.
 *
 * A caller that keeps going well past the ceiling is disconnected rather than refused forever:
 * answering a flood with an error packet per request is still work we are doing on its behalf.
 */
const EVENT_BUDGET = 120;
const EVENT_WINDOW_MS = 10_000;
/** Past this much over budget, stop replying and drop the connection. */
const DISCONNECT_MULTIPLIER = 5;

function installEventBudget(socket: Socket) {
  let windowStart = Date.now();
  let count = 0;

  socket.use((_packet, next) => {
    const now = Date.now();

    if (now - windowStart >= EVENT_WINDOW_MS) {
      windowStart = now;
      count = 0;
    }

    count += 1;

    if (count > EVENT_BUDGET * DISCONNECT_MULTIPLIER) {
      socket.disconnect(true);
      return;
    }

    if (count > EVENT_BUDGET) {
      // Reaches the client as an `error` event. Deliberately not silent: a legitimate client
      // hitting this is a bug worth seeing, and a dropped packet with no reply looks like the
      // server hanging.
      next(new Error("Too many requests on this connection. Slow down."));
      return;
    }

    next();
  });
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
    // Needed by the class handlers: academy staff may join any class room, and
    // without the role here `canAccess` could only ever see the coach and the
    // enrolled students.
    socket.data.role = payload.role;

    installEventBudget(socket);

    // Personal room for direct server→user emits (notifications, etc.).
    socket.join(`user:${payload.userId}`);

    setupPresenceHandlers(io, socket, connectedUsers);
    setupLobbyHandlers(io, socket);
    setupGameHandlers(io, socket);
    setupTournamentHandlers(io, socket);
    setupClassHandlers(io, socket);
    setupMediaHandlers(io, socket);

    socket.on("disconnect", () => {
      connectedUsers.delete(socket.id);
      io.emit("presence:online-count", new Set(connectedUsers.values()).size);
      io.emit("presence:online-users", Array.from(new Set(connectedUsers.values())));
    });
  });
}
