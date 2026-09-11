import { NextRequest, NextResponse } from "next/server";
import { verifyAccessToken } from "@/lib/auth";
import { db } from "@/lib/db";
import { writeAuditLog } from "@/lib/audit";
import { attendanceMarkSchema } from "@/lib/validations/admin";

export const runtime = "nodejs";

/** The class's coach, or HR/HEAD, may mark and read its attendance. */
async function canManageClass(classId: string, payload: { userId: string; role: string }) {
  if (payload.role === "HR" || payload.role === "HEAD") return true;
  const cls = await db.class.findUnique({
    where: { id: classId },
    select: { coach: { select: { userId: true } } },
  });
  return Boolean(cls && cls.coach?.userId === payload.userId);
}

/** Attendance for one class, with the roster so unmarked students still appear. */
export async function GET(request: NextRequest) {
  const token = request.cookies.get("kca_access_token")?.value;
  if (!token) return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });

  let payload;
  try {
    payload = verifyAccessToken(token);
  } catch {
    return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
  }

  const classId = request.nextUrl.searchParams.get("classId");
  if (!classId) return NextResponse.json({ success: false, message: "classId is required" }, { status: 400 });

  if (!(await canManageClass(classId, payload))) {
    return NextResponse.json({ success: false, message: "Not found" }, { status: 404 });
  }

  const cls = await db.class.findUnique({
    where: { id: classId },
    select: { id: true, title: true, startsAt: true, batchId: true },
  });
  if (!cls) return NextResponse.json({ success: false, message: "Not found" }, { status: 404 });

  const [roster, marked] = await Promise.all([
    db.classEnrollment.findMany({
      where: { OR: [{ classId }, ...(cls.batchId ? [{ batchId: cls.batchId }] : [])] },
      select: { user: { select: { id: true, username: true } } },
    }),
    db.classAttendance.findMany({
      where: { classId },
      select: { userId: true, status: true, note: true, markedAt: true },
    }),
  ]);

  const byUser = new Map(marked.map((m) => [m.userId, m]));
  const students = [...new Map(roster.map((r) => [r.user.id, r.user])).values()].map((u) => ({
    ...u,
    status: byUser.get(u.id)?.status ?? null,
    note: byUser.get(u.id)?.note ?? null,
    markedAt: byUser.get(u.id)?.markedAt ?? null,
  }));

  return NextResponse.json({ success: true, class: cls, students });
}

/** Mark (or correct) attendance. Idempotent per class+student. */
export async function POST(request: NextRequest) {
  const token = request.cookies.get("kca_access_token")?.value;
  if (!token) return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });

  let payload;
  try {
    payload = verifyAccessToken(token);
  } catch {
    return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const parsed = attendanceMarkSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, message: "Validation failed.", errors: parsed.error.flatten().fieldErrors },
      { status: 400 },
    );
  }

  const { classId, entries } = parsed.data;
  if (!(await canManageClass(classId, payload))) {
    return NextResponse.json({ success: false, message: "Not found" }, { status: 404 });
  }

  // Upsert so re-marking corrects the row rather than creating a contradictory
  // second one (the unique index on class+student enforces this too).
  await db.$transaction(
    entries.map((e) =>
      db.classAttendance.upsert({
        where: { classId_userId: { classId, userId: e.userId } },
        create: { classId, userId: e.userId, status: e.status, note: e.note, markedById: payload.userId },
        update: { status: e.status, note: e.note, markedById: payload.userId, markedAt: new Date() },
      }),
    ),
  );

  await writeAuditLog({
    action: "attendance.mark",
    userId: payload.userId,
    metadata: { classId, count: entries.length },
    request,
  });

  return NextResponse.json({ success: true, marked: entries.length });
}
