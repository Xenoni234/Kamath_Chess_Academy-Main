import type { Server, Socket } from "socket.io";
import type { types } from "mediasoup";
import {
  createWebRtcTransport,
  getRouter,
  mediaEnabled,
  transportParams,
} from "../../media/mediasoup.ts";
import { canAccess } from "./classHandlers.ts";

/**
 * mediasoup signalling over Socket.io (Phase 6 v2).
 *
 * Every event is scoped to a class room the socket has already joined via
 * `class:join` (which authorized access) — membership in `class:<id>` is the gate
 * here, so a socket cannot produce/consume in a room it never entered. Events use
 * acknowledgement callbacks because the mediasoup-client handshake is request/reply.
 */

type Peer = {
  username: string;
  transports: Map<string, types.WebRtcTransport>;
  producers: Map<string, types.Producer>;
  consumers: Map<string, types.Consumer>;
};

// classId -> (socketId -> Peer). Server-process lifetime; the socket server is
// set up once at boot, so a module map is safe (no HMR reload here).
const rooms = new Map<string, Map<string, Peer>>();

function room(classId: string) {
  return `class:${classId}`;
}

function peersOf(classId: string): Map<string, Peer> {
  let p = rooms.get(classId);
  if (!p) {
    p = new Map();
    rooms.set(classId, p);
  }
  return p;
}

function getPeer(classId: string, socket: Socket): Peer {
  const peers = peersOf(classId);
  let peer = peers.get(socket.id);
  if (!peer) {
    peer = {
      username: (socket.data.username as string) ?? "student",
      transports: new Map(),
      producers: new Map(),
      consumers: new Map(),
    };
    peers.set(socket.id, peer);
  }
  return peer;
}

/** Tear down one peer's media and tell the room its producers are gone. */
function cleanupPeer(io: Server, classId: string, socketId: string) {
  const peers = rooms.get(classId);
  const peer = peers?.get(socketId);
  if (!peer) return;
  for (const producerId of peer.producers.keys()) {
    io.to(room(classId)).emit("media:producer-closed", { producerId });
  }
  for (const t of peer.transports.values()) t.close(); // closes its producers/consumers
  peers!.delete(socketId);
  io.to(room(classId)).emit("media:peer-left", { peerId: socketId });
}

type Ack<T> = (response: T) => void;

export function setupMediaHandlers(io: Server, socket: Socket) {
  const joined = new Set<string>();
  const inRoom = (classId: string) => socket.rooms.has(room(classId));

  socket.on("media:capabilities", async ({ classId }: { classId: string }, cb: Ack<unknown>) => {
    // Entry point: authorize independently (don't depend on class:join ordering)
    // and join the room so subsequent media events pass the `inRoom` gate.
    if (!mediaEnabled()) return cb({ error: "unavailable" });
    if (!(await canAccess(classId, socket.data.userId))) return cb({ error: "forbidden" });
    socket.join(room(classId));
    const router = await getRouter(classId);
    joined.add(classId);
    cb({ rtpCapabilities: router.rtpCapabilities });
  });

  socket.on(
    "media:create-transport",
    async ({ classId }: { classId: string; direction: "send" | "recv" }, cb: Ack<unknown>) => {
      if (!mediaEnabled() || !inRoom(classId)) return cb({ error: "unavailable" });
      const router = await getRouter(classId);
      const transport = await createWebRtcTransport(router);
      getPeer(classId, socket).transports.set(transport.id, transport);
      cb(transportParams(transport));
    },
  );

  socket.on(
    "media:connect-transport",
    async (
      { classId, transportId, dtlsParameters }: { classId: string; transportId: string; dtlsParameters: types.DtlsParameters },
      cb: Ack<unknown>,
    ) => {
      const transport = getPeer(classId, socket).transports.get(transportId);
      if (!transport) return cb({ error: "no transport" });
      await transport.connect({ dtlsParameters });
      cb({ ok: true });
    },
  );

  socket.on(
    "media:produce",
    async (
      {
        classId,
        transportId,
        kind,
        rtpParameters,
        appData,
      }: { classId: string; transportId: string; kind: types.MediaKind; rtpParameters: types.RtpParameters; appData?: Record<string, unknown> },
      cb: Ack<unknown>,
    ) => {
      const peer = getPeer(classId, socket);
      const transport = peer.transports.get(transportId);
      if (!transport) return cb({ error: "no transport" });
      const producer = await transport.produce({ kind, rtpParameters, appData: { ...appData, peerId: socket.id } });
      peer.producers.set(producer.id, producer);
      // Tell everyone else in the room there's a new stream to consume.
      socket.to(room(classId)).emit("media:new-producer", {
        producerId: producer.id,
        peerId: socket.id,
        username: peer.username,
        kind,
        appData: appData ?? {},
      });
      cb({ id: producer.id });
    },
  );

  socket.on(
    "media:consume",
    async (
      {
        classId,
        transportId,
        producerId,
        rtpCapabilities,
      }: { classId: string; transportId: string; producerId: string; rtpCapabilities: types.RtpCapabilities },
      cb: Ack<unknown>,
    ) => {
      const router = await getRouter(classId);
      if (!router.canConsume({ producerId, rtpCapabilities })) return cb({ error: "cannot consume" });
      const peer = getPeer(classId, socket);
      const transport = peer.transports.get(transportId);
      if (!transport) return cb({ error: "no transport" });
      const consumer = await transport.consume({ producerId, rtpCapabilities, paused: true });
      peer.consumers.set(consumer.id, consumer);
      cb({
        id: consumer.id,
        producerId,
        kind: consumer.kind,
        rtpParameters: consumer.rtpParameters,
        appData: consumer.appData,
      });
    },
  );

  socket.on(
    "media:resume-consumer",
    async ({ classId, consumerId }: { classId: string; consumerId: string }, cb: Ack<unknown>) => {
      const consumer = getPeer(classId, socket).consumers.get(consumerId);
      if (!consumer) return cb({ error: "no consumer" });
      await consumer.resume();
      cb({ ok: true });
    },
  );

  // Existing producers in the room, so a joiner can consume what's already live.
  socket.on("media:producers", ({ classId }: { classId: string }, cb: Ack<unknown>) => {
    const peers = rooms.get(classId);
    const list: unknown[] = [];
    if (peers) {
      for (const [peerId, peer] of peers) {
        if (peerId === socket.id) continue;
        for (const producer of peer.producers.values()) {
          list.push({ producerId: producer.id, peerId, username: peer.username, kind: producer.kind, appData: producer.appData });
        }
      }
    }
    cb({ producers: list });
  });

  // Explicit producer close (e.g. the coach stops screen-sharing).
  socket.on("media:close-producer", ({ classId, producerId }: { classId: string; producerId: string }) => {
    const peer = rooms.get(classId)?.get(socket.id);
    const producer = peer?.producers.get(producerId);
    if (!producer) return;
    producer.close();
    peer!.producers.delete(producerId);
    io.to(room(classId)).emit("media:producer-closed", { producerId });
  });

  socket.on("media:leave", ({ classId }: { classId: string }) => {
    joined.delete(classId);
    cleanupPeer(io, classId, socket.id);
  });

  socket.on("disconnect", () => {
    for (const classId of joined) cleanupPeer(io, classId, socket.id);
  });
}
