/**
 * mediasoup SFU (Phase 6 v2) — the server-side media layer.
 *
 * A Selective Forwarding Unit: it forwards each participant's tracks to the
 * others without mixing, so CPU scales with participants, not with an encode.
 * One Worker per CPU core, one Router per class room, WebRtcTransports per peer
 * carrying Producers (their outgoing tracks) and Consumers (others' tracks).
 *
 * Signalling rides the existing authenticated Socket.io class room
 * (handlers/mediaHandlers.ts). This module owns only the media objects and their
 * lifecycle.
 *
 * Enablement:
 *   - dev: on by default (listens on 127.0.0.1 — same-machine two-tab testing works).
 *   - prod: set MEDIASOUP_ENABLED=true AND MEDIASOUP_ANNOUNCED_IP=<public IP>, open
 *     the UDP port range, and run a TURN server. Without it, the room falls back to
 *     the v1 embedded video (Jitsi / meetingUrl).
 */
import * as mediasoup from "mediasoup";
import type { types } from "mediasoup";

const MIN_PORT = Number(process.env.MEDIASOUP_MIN_PORT ?? 40000);
const MAX_PORT = Number(process.env.MEDIASOUP_MAX_PORT ?? 40100);
const LISTEN_IP = process.env.MEDIASOUP_LISTEN_IP || "127.0.0.1";
const ANNOUNCED_IP = process.env.MEDIASOUP_ANNOUNCED_IP || undefined;

/** SFU on when explicitly enabled, or by default in dev; off in prod unless set. */
export function mediaEnabled(): boolean {
  if (process.env.MEDIASOUP_ENABLED === "false") return false;
  if (process.env.MEDIASOUP_ENABLED === "true") return true;
  return process.env.NODE_ENV !== "production";
}

const MEDIA_CODECS: types.RtpCodecCapability[] = [
  { kind: "audio", mimeType: "audio/opus", preferredPayloadType: 100, clockRate: 48000, channels: 2 },
  {
    kind: "video",
    mimeType: "video/VP8",
    preferredPayloadType: 96,
    clockRate: 90000,
    parameters: { "x-google-start-bitrate": 1000 },
  },
];

// Memoise on globalThis so dev HMR / repeated imports don't spawn worker pools.
type MediaGlobal = {
  workers?: types.Worker[];
  nextWorker?: number;
  routers?: Map<string, types.Router>; // classId -> Router
};
const g = globalThis as unknown as { __kcaMedia?: MediaGlobal };
g.__kcaMedia ??= {};
const store = g.__kcaMedia;
store.routers ??= new Map();

async function getWorkers(): Promise<types.Worker[]> {
  if (store.workers?.length) return store.workers;
  const count = Math.max(1, Math.min(4, (await import("node:os")).cpus().length));
  const workers: types.Worker[] = [];
  for (let i = 0; i < count; i++) {
    const worker = await mediasoup.createWorker({ rtcMinPort: MIN_PORT, rtcMaxPort: MAX_PORT });
    worker.on("died", () => {
      console.error("[media] worker died, pid", worker.pid);
    });
    workers.push(worker);
  }
  store.workers = workers;
  store.nextWorker = 0;
  console.log(`[media] ${workers.length} mediasoup worker(s) started`);
  return workers;
}

/** Round-robin a worker for a new router. */
async function pickWorker(): Promise<types.Worker> {
  const workers = await getWorkers();
  const i = store.nextWorker ?? 0;
  store.nextWorker = (i + 1) % workers.length;
  return workers[i];
}

/** Get (or lazily create) the Router for a class room. */
export async function getRouter(classId: string): Promise<types.Router> {
  const existing = store.routers!.get(classId);
  if (existing && !existing.closed) return existing;
  const worker = await pickWorker();
  const router = await worker.createRouter({ mediaCodecs: MEDIA_CODECS });
  store.routers!.set(classId, router);
  return router;
}

/** Close and forget a room's Router (all its transports/producers close with it). */
export function closeRouter(classId: string): void {
  const router = store.routers!.get(classId);
  if (router && !router.closed) router.close();
  store.routers!.delete(classId);
}

/** Create a WebRtcTransport on a router for one peer's send or recv side. */
export async function createWebRtcTransport(router: types.Router): Promise<types.WebRtcTransport> {
  return router.createWebRtcTransport({
    listenIps: [{ ip: LISTEN_IP, announcedIp: ANNOUNCED_IP }],
    enableUdp: true,
    enableTcp: true,
    preferUdp: true,
    initialAvailableOutgoingBitrate: 1_000_000,
  });
}

/** Serialisable transport params the client needs to connect. */
export function transportParams(t: types.WebRtcTransport) {
  return {
    id: t.id,
    iceParameters: t.iceParameters,
    iceCandidates: t.iceCandidates,
    dtlsParameters: t.dtlsParameters,
  };
}
