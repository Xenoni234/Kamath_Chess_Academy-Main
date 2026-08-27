import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { verifyAccessToken } from "@/lib/auth";
import { db } from "@/lib/db";
import { createNotifications } from "@/lib/notify";
import { writeAuditLog } from "@/lib/audit";

export const runtime = "nodejs";

/** Coach of the class, or a student enrolled in it / its batch. */
async function access(classId: string, userId: string) {
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
      batchId: true,
      coach: { select: { userId: true, user: { select: { username: true } } } },
    },
  });
  if (!cls) return { cls: null as null, isCoach: false, allowed: false };
  const isCoach = cls.coach?.userId === userId;
  if (isCoach) return { cls, isCoach: true, allowed: true };
  const enrolled = await db.classEnrollment.findFirst({
    where: { userId, OR: [{ classId }, ...(cls.batchId ? [{ batchId: cls.batchId }] : [])] },
    select: { id: true },
  });
  return { cls, isCoach: false, allowed: Boolean(enrolled) };
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
  const { cls, isCoach, allowed } = await access(id, payload.userId);
  if (!cls) return NextResponse.json({ success: false, message: "Not found" }, { status: 404 });
  // 404, not 403 — don't reveal a class exists to someone not in it.
  if (!allowed) return NextResponse.json({ success: false, message: "Not found" }, { status: 404 });

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
      coachName: cls.coach?.user.username ?? null,
    },
    isCoach,
    viewerName: payload.username,
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
  const { cls, isCoach } = await access(id, payload.userId);
  if (!cls) return NextResponse.json({ success: false, message: "Not found" }, { status: 404 });
  if (!isCoach) return NextResponse.json({ success: false, message: "Only the class coach can do that" }, { status: 403 });

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
    await db.class.update({ where: { id }, data: { status: "ONGOING", liveStartedAt: new Date() } });
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
  await writeAuditLog({ action: "class.room.end", userId: payload.userId, metadata: { classId: id }, request });
  return NextResponse.json({ success: true, status: "COMPLETED" });
}
