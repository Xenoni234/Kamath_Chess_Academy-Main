# Phase 6 — Video Classes: plan & launch recommendation

**Status:** BUILT. v1 (chat + roster + embedded video) and v2 (mediasoup SFU) are both
implemented. The SFU is **opt-in** (`MEDIASOUP_ENABLED`) and the room falls back to embedded
Jitsi / `meetingUrl` when it's off — so classes work in any deploy. Server signalling verified
end-to-end (worker/router/transport/ICE); two-camera media flow needs real browsers to test.
See §"Deployed state" at the bottom and `DEPLOYMENT.md §8.5`.

**Goal (roadmap):** inbuilt group video for live classes via a **mediasoup WebRTC SFU** (no
third-party API), Socket.io signalling, screen sharing for board demonstration, and in-class chat.

---

## TL;DR — the recommendation

**Do not build the full mediasoup SFU before the 14 Sept launch.** It is a large, infra-heavy
subsystem (media servers, a UDP port range, a public "announced IP", a TURN server, per-room CPU)
that adds real operational risk right when the goal is a lean launch for genuine feedback.

Instead, ship classes in **two stages**:

- **v1 (for launch):** a real **class room page** with **in-class chat over the existing Socket.io**
  + video via an **embedded [Jitsi Meet](https://jitsi.org) room** (free, self-serve, zero media
  infra) *or* the existing `Class.meetingUrl` external link. Coaches can run real classes on day one.
- **v2 (post-launch, the true Phase 6):** replace the embedded video with the **self-hosted mediasoup
  SFU** for full control, once there's feedback and traffic to justify the ops.

This gets a working, feedback-worthy classroom live on time, and keeps the SFU as a deliberate,
well-resourced project rather than a launch-blocking scramble.

---

## What already exists (reuse, don't rebuild)

- **Authenticated Socket.io** — `src/lib/socket/server.ts` `setupSocketServer(io)`: cookie-JWT auth
  (`authenticateSocket`), a per-user room `user:<userId>`, and a clean per-feature handler pattern
  (`handlers/{game,lobby,presence,tournament}Handlers.ts`). **Video signalling and in-class chat are
  just two more handler modules** (`classHandlers.ts`) joining a `class:<classId>` room. Same auth,
  same `io.to(room).emit` pattern.
- **`setIo` / `io.ts`** — API routes already emit to socket rooms (notifications). A class-start
  route can notify `class:<id>` the same way.
- **Class scheduling (Phase 3)** — `Class` (`prisma/schema.prisma:360`) already has `coachId`,
  `startsAt/endsAt`, `status: ClassStatus`, and crucially **`meetingUrl String?`**; `ClassEnrollment`
  ties students to a class/batch. HR/HEAD already schedule classes. So the *scheduling and roster
  half of Phase 6 is done* — only the live room is missing.
- **`requireRole` / `writeAuditLog` / `createNotification`** — reuse for room authorization
  (coach-runs, enrolled-students-join), audit, and "class is live" pushes.
- **Presence** — `presenceHandlers` already tracks who's online; extend for "who's in the room".

## The COEP gotcha (important, applies to BOTH stages)

`server.mjs` sets **`Cross-Origin-Embedder-Policy: require-corp`** globally so `SharedArrayBuffer`
is available for multi-threaded Stockfish. Under `require-corp`, **an embedded third-party video
iframe (Jitsi) or many cross-origin media resources are blocked** unless they send `CORP`/COEP
headers, which Jitsi does not.

The class room page does **not** need Stockfish threads, so the fix is to **serve the class-room
route without the COEP header** (a per-route/middleware exception in `src/proxy.ts` or a response
header override for `/dashboard/classes/[id]/room`). Self-hosted mediasoup (v2) is same-origin and
sidesteps this entirely — a point in the SFU's favour long-term.

---

## v1 — launch classroom (small, safe, ~1–2 days)

**Data:** add a `Message` model for in-class chat (and optionally a `liveStartedAt` on `Class`):
```prisma
model Message {
  id        String   @id @default(cuid())
  classId   String
  userId    String
  body      String   @db.Text
  createdAt DateTime @default(now())
  class     Class    @relation(fields: [classId], references: [id], onDelete: Cascade)
  user      User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  @@index([classId, createdAt])
  @@map("class_messages")
}
```
Apply with `npx prisma db push` (after the Mumbai migration, so it lands on the new DB).

**Signalling/chat handler:** `src/lib/socket/handlers/classHandlers.ts` — `class:join` (authorize:
coach of the class or an enrolled student → join `class:<id>`), `class:message` (validate with Zod,
persist `Message`, `io.to(class:<id>).emit("class:message", …)`), `class:leave`, and a roster
(`class:roster`) built from room membership.

**Routes:** `src/app/api/classes/[id]/room/route.ts` (GET room context: authorize + class + recent
messages), reusing the cookie-auth + `requireRole` pattern.

**UI:** `src/app/(dashboard)/classes/[id]/room/page.tsx` — a Jitsi `<iframe>` (or the external
`meetingUrl`) as the video pane, an in-class **chat panel** over Socket.io, and a roster. Coaches get
a "Start class" control (sets `status=LIVE`, notifies enrolled students via `createNotification`).
**Serve this route without COEP** (see the gotcha above).

**Result:** real, scheduled classes with video + chat + roster, on existing infra, for launch.

---

## v2 — the mediasoup SFU (post-launch, the real Phase 6)

Replace the embedded video with a self-hosted **Selective Forwarding Unit**. High-level design:

**Media layer (`src/lib/media/` + a mediasoup process):**
- One or more **mediasoup Workers** (one per CPU core), each hosting **Routers** (one Router per
  class room). A Router carries **WebRtcTransports** per participant, which carry **Producers**
  (a participant's outgoing audio/video/screen tracks) and **Consumers** (others' tracks forwarded
  to them). The SFU forwards streams — it never mixes — so CPU scales with participants, not with an
  encode.
- Runs **in-process with `server.mjs`** for v1 of the SFU (simplest), or as a **separate media
  service** later for independent scaling.

**Signalling (reuse Socket.io):** extend `classHandlers.ts` with the mediasoup handshake —
`getRouterRtpCapabilities`, `createWebRtcTransport`, `connectTransport`, `produce`, `consume`,
`resume`. This is the standard mediasoup client/server dance; the transport of these messages is the
**existing authenticated Socket.io room**, so auth/rooms/roster are already solved.

**Client (`react`):** `mediasoup-client` `Device`, load router caps, create send/recv transports,
`produce()` camera+mic (+ a second `produce()` for `getDisplayMedia()` screen share — the board
demo), render a video grid of consumers. Screen share is just another producer with `appData:
{ share: true }` pinned large.

**Infra (the heavy part — why it's post-launch):**
- A **UDP port range** open on the VPS (e.g. `40000–40100/udp`) for RTP, plus the announced public
  IP configured on the WebRtcTransport (`listenIps: [{ ip: 0.0.0.0, announcedIp: <PUBLIC_IP> }]`).
- A **TURN/STUN server** (self-host **coturn**) so participants behind strict NATs still connect —
  without it, some students simply can't join. This is a second service to run and secure.
- **CPU/'​bandwidth budget** per room; plan worker count and a per-room participant cap.
- Docker Compose gains a `coturn` service and the app container needs the UDP range published.

**Build phases (v2):**
1. mediasoup worker/router bootstrap + `getRouterRtpCapabilities` over Socket.io.
2. Transport create/connect + a single producer/consumer (one-to-one audio/video) end-to-end.
3. Multi-party grid (N producers/consumers per room) + roster wiring.
4. Screen share producer (board demonstration).
5. coturn + announced-IP hardening; NAT traversal verified from a phone on cellular.
6. Reconnection, room teardown on class end, per-room caps, audit/notifications.

---

## Data-model additions (summary)
- **v1:** `Message` (`class_messages`) for chat; optional `Class.liveStartedAt` / a `LIVE` status.
- **v2:** likely a `ClassSession` (live-room lifecycle, active producers) if we want persistence of
  who joined/when; not required for the SFU to work.

## Reuse map
| Need | Reuse |
|---|---|
| Auth on the room socket | `authenticateSocket` (`socket/server.ts:26`) |
| Room fan-out | `io.to("class:<id>").emit(...)` (same as game/tournament rooms) |
| Server→user push ("class is live") | `createNotification` + `user:<id>` room |
| Role checks (coach vs student) | `requireRole` (Phase 3) |
| Audit | `writeAuditLog` |
| Scheduling + roster | `Class` / `ClassEnrollment` (done) |

## Risks / why v2 is post-launch
- **NAT traversal is not optional** — no TURN means silent join failures for a real fraction of
  users; coturn is a whole sub-project to run reliably.
- **Media CPU/bandwidth** scale with concurrent rooms — needs load thinking the launch doesn't yet
  have data for.
- **COEP** interaction (above) and the single-instance in-memory Socket.io adapter (fine for launch,
  needs the Redis adapter before multi-instance scaling).
- Building all of this correctly is days of focused work — exactly what a lean, on-time launch should
  not gate on.

---

## Recommended next actions
1. **Confirm the v1-then-v2 split** (or say if you want the full SFU regardless).
2. On approval, I build **v1** (Message model + `classHandlers` chat + room page + Jitsi/`meetingUrl`
   video + COEP exception) — small enough to land well before 14 Sept.
3. Schedule **v2 (mediasoup SFU)** as the first post-launch project, using this plan.

---

## Deployed state (what was built)

**v1 — launch classroom (works with zero media infra):**
- `Message` model + `Class.liveStartedAt` (`prisma/schema.prisma`, pushed to DB).
- `src/lib/socket/handlers/classHandlers.ts` — `class:join/leave/message` + roster, access-gated
  (coach or enrolled). Wired in `src/lib/socket/server.ts`.
- `src/app/api/classes/[id]/room/route.ts` — room context/history (GET) + coach start/end + notify (POST).
- `src/app/(dashboard)/dashboard/classes/[id]/room/page.tsx` — room page: video pane + chat + roster
  + coach controls. Reachable via a full-navigation "Enter room" link on the classes list.
- `server.mjs` — COEP exception for the room route so the embedded (cross-origin) video iframe loads.

**v2 — mediasoup SFU (opt-in via `MEDIASOUP_ENABLED`):**
- `src/lib/media/mediasoup.ts` — worker pool (1 per core, capped), per-room routers, transports,
  codec config, `mediaEnabled()` gate (dev-on, prod needs the env).
- `src/lib/socket/handlers/mediaHandlers.ts` — full signalling: capabilities, create/connect
  transport, produce, consume, resume, producer listing, screen-share close, per-peer teardown.
  Wired in `server.ts`.
- `src/lib/media/roomClient.ts` — `useMediaRoom` hook: Device load, send/recv transports, publish
  camera+mic, consume peers, screen share, mic/cam toggles, cleanup.
- Room page renders the SFU grid (`SfuStage`) when enabled, else the v1 fallback.
- `.env.example` + `DEPLOYMENT.md §8.5` — SFU env, UDP port range, coturn/TURN guidance.

**Verified:** `tsc` clean · `npm run build` clean · mediasoup worker/router/transport boot · live
socket signalling (auth → access → capabilities → transport ICE → producers) via a scripted client.
**Not machine-testable here:** two real browsers exchanging camera/screen video — test that on
localhost (two tabs) or after deploying with a public `MEDIASOUP_ANNOUNCED_IP` + TURN.

## Still ahead for v2 hardening (post-launch)
- **coturn/TURN** wired into client ICE servers (NAT traversal for all users).
- Reconnection on transport failure; per-room participant caps; simulcast/bandwidth tuning.
- The Socket.io **Redis adapter** before running more than one app instance.
