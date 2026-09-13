import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { verifyAccessToken } from "@/lib/auth";
import { db } from "@/lib/db";
import { createNotifications } from "@/lib/notify";
import { writeAuditLog } from "@/lib/audit";
// The SFU switch comes from its own dependency-free module so this route never
// imports the native mediasoup binding, which exists only in the socket server.
import { mediaEnabledFromEnv } from "@/lib/media/enabled";
import { jaasAppId, jaasConfigured, mintJaasToken } from "@/lib/media/jaas";

export const runtime = "nodejs";

/** 128 bits of URL-safe randomness — not derivable from the class id. */
function newRoomKey(): string {
  return crypto.randomBytes(16).toString("base64url");
}

/**
 * Who this caller is in this room.
 *
 * `isCoach` is strictly the assigned coach. `canManage` is broader — it also
 * covers HR and HEAD, who run the academy and may need to start a class, add a
 * student or mark attendance when a coach is unavailable. The attendance and
 * enrolment APIs already used the wider rule, so gating the room's controls on
 * `isCoach` alone meant the head could not press buttons the server would have
 * happily accepted.
 */
async function access(classId: string, userId: string, role: string) {
  const cls = await db.class.findUnique({
    where: { id: classId },
    select: {
      id: true,
      title: true,
      description: true,
      status: true,
      startsAt: true,
      endsAt: true,
      meetingUrl: true,
      liveStartedAt: true,
      videoRoomKey: true,
      batchId: true,
      coach: { select: { userId: true, user: { select: { username: true } } } },
    },
  });
  if (!cls) return { cls: null as null, isCoach: false, canManage: false, allowed: false };
  const isCoach = cls.coach?.userId === userId;
  const isStaff = role === "HR" || role === "HEAD";
  const canManage = isCoach || isStaff;
  if (canManage) return { cls, isCoach, canManage, allowed: true };
  const enrolled = await db.classEnrollment.findFirst({
    where: { userId, OR: [{ classId }, ...(cls.batchId ? [{ batchId: cls.batchId }] : [])] },
    select: { id: true },
  });
  return { cls, isCoach: false, canManage: false, allowed: Boolean(enrolled) };
}

/** Room context: class details, recent chat history, and the caller's role. */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const token = request.cookies.get("kca_access_token")?.value;
  if (!token) return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
  let payload;
  try {
    payload = verifyAccessToken(token);
  } catch {
    return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const { cls, isCoach, canManage, allowed } = await access(id, payload.userId, payload.role);
  if (!cls) return NextResponse.json({ success: false, message: "Not found" }, { status: 404 });
  // 404, not 403 — don't reveal a class exists to someone not in it.
  if (!allowed) return NextResponse.json({ success: false, message: "Not found" }, { status: 404 });

  // The Jitsi room used to be named `KCA-<class id>`, i.e. derivable by anyone who
  // knew or guessed a class id — an unauthenticated room full of minors. The room
  // name is now a secret, generated on first authorised view and handed out ONLY
  // past the `allowed` check above, so it never reaches a non-participant.
  let videoRoomKey = cls.videoRoomKey;
  if (!videoRoomKey) {
    videoRoomKey = newRoomKey();
    try {
      await db.class.update({ where: { id }, data: { videoRoomKey } });
    } catch {
      // Lost a race with a concurrent first viewer; theirs is authoritative.
      const fresh = await db.class.findUnique({ where: { id }, select: { videoRoomKey: true } });
      videoRoomKey = fresh?.videoRoomKey ?? videoRoomKey;
    }
  }

  const messages = await db.message.findMany({
    where: { classId: id },
    orderBy: { createdAt: "asc" },
    take: 100,
    select: { id: true, userId: true, body: true, createdAt: true, user: { select: { username: true } } },
  });

  return NextResponse.json({
    success: true,
    room: {
      id: cls.id,
      title: cls.title,
      description: cls.description,
      status: cls.status,
      startsAt: cls.startsAt,
      endsAt: cls.endsAt,
      meetingUrl: cls.meetingUrl,
      liveStartedAt: cls.liveStartedAt,
      videoRoomKey,
      coachName: cls.coach?.user.username ?? null,
    },
    /**
     * A JaaS token for THIS person joining THIS room, minted only past the authorisation
     * gate above — the same gate that guards `videoRoomKey`. Null when JaaS is not
     * configured, in which case the client falls back to public meet.jit.si.
     *
     * This is what removes the second login: Jitsi is told who the viewer is by a
     * signature it trusts, so it stops asking a nine-year-old to sign in with Google.
     * The coach gets moderator; everyone else joins as a participant.
     */
    jaas: jaasConfigured()
      ? {
          appId: jaasAppId(),
          room: `${jaasAppId()}/KCA-${videoRoomKey}`,
          token: mintJaasToken({
            room: `KCA-${videoRoomKey}`,
            userId: payload.userId,
            name: payload.username,
            role: isCoach || canManage ? "moderator" : "participant",
          }),
        }
      : null,
    isCoach,
    canManage,
    viewerName: payload.username,
    sfuEnabled: mediaEnabledFromEnv(),
    messages: messages.map((m) => ({
      id: m.id,
      userId: m.userId,
      username: m.user.username,
      body: m.body,
      createdAt: m.createdAt,
    })),
  });
}

const actionSchema = z.object({ action: z.enum(["start", "end"]) });

/** Coach starts or ends the live class. Starting notifies enrolled students. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const token = request.cookies.get("kca_access_token")?.value;
  if (!token) return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
  let payload;
  try {
    payload = verifyAccessToken(token);
  } catch {
    return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const { cls, canManage } = await access(id, payload.userId, payload.role);
  if (!cls) return NextResponse.json({ success: false, message: "Not found" }, { status: 404 });
  if (!canManage) {
    return NextResponse.json(
      { success: false, message: "Only the class coach or academy staff can do that" },
      { status: 403 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, message: "Invalid request body" }, { status: 400 });
  }
  const parsed = actionSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ success: false, message: "Invalid action" }, { status: 400 });
  }

  if (parsed.data.action === "start") {
    // Rotate the room name on every start. A link forwarded out of last week's
    // class must not open this week's — obscurity only holds if it expires.
    await db.class.update({
      where: { id },
      data: { status: "ONGOING", liveStartedAt: new Date(), videoRoomKey: newRoomKey() },
    });
    // Notify enrolled students the class is live.
    const enrollments = await db.classEnrollment.findMany({
      where: { OR: [{ classId: id }, ...(cls.batchId ? [{ batchId: cls.batchId }] : [])] },
      select: { userId: true },
    });
    const unique = [...new Set(enrollments.map((e) => e.userId))];
    if (unique.length) {
      await createNotifications(
        unique.map((userId) => ({
          userId,
          type: "SYSTEM" as const,
          title: "Class is live",
          body: `"${cls.title}" has started — join the room now.`,
        })),
      ).catch(() => {});
    }
    await writeAuditLog({ action: "class.room.start", userId: payload.userId, metadata: { classId: id }, request });
    return NextResponse.json({ success: true, status: "ONGOING" });
  }

  await db.class.update({ where: { id }, data: { status: "COMPLETED" } });

  // Actually end it. Without this, "End class" only changed a status column —
  // the video kept running and everyone stayed connected, so the lesson was over
  // in the database and nowhere else.
  //
  // Imported lazily: this module pulls in the native mediasoup binding, which
  // exists only in the custom Socket.io server process. A static import would
  // break every Next build that touches this route.
  try {
    const { closeClassMedia } = await import("@/lib/socket/handlers/mediaHandlers");
    closeClassMedia(id);
  } catch (error) {
    console.error("[classes/[id]/room] could not close the media room:", error);
  }

  await writeAuditLog({ action: "class.room.end", userId: payload.userId, metadata: { classId: id }, request });
  return NextResponse.json({ success: true, status: "COMPLETED" });
}
