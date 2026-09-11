/**
 * Change or remove a class after it has been scheduled.
 *
 * There was no route here at all, which meant a class, once created, was
 * permanent: a coach who scheduled a session for the wrong evening could not move
 * it, could not cancel it, and had no way to tell the students it was off. The
 * head had no way either — so "the head can override anyone" was not true of the
 * one object the academy revolves around.
 *
 * Who may act is `canManageClass`: the class's own coach, or HR/HEAD for any
 * class. A coach editing someone else's gets **404, not 403** — the same rule as
 * every other scoped resource here, so class ids cannot be probed for existence.
 *
 * Cancelling is a status change, never a delete. Students were told the class was
 * happening, the attendance and audit history is real, and the coach-activity
 * numbers are computed from these rows. DELETE exists for the head alone, for
 * rows that should never have existed.
 */
import { NextRequest, NextResponse } from "next/server";
import { verifyAccessToken } from "@/lib/auth";
import { canManageClass } from "@/lib/authz";
import { db } from "@/lib/db";
import { updateClassSchema } from "@/lib/validations/phase3";
import { createNotifications } from "@/lib/notify";
import { writeAuditLog } from "@/lib/audit";

export const runtime = "nodejs";

/** Everyone who should hear that a class moved: the batch, the class, the coach. */
async function audienceFor(cls: { id: string; batchId: string | null; coachUserId: string | null }) {
  const enrolments = await db.classEnrollment.findMany({
    where: { OR: [{ classId: cls.id }, ...(cls.batchId ? [{ batchId: cls.batchId }] : [])] },
    select: { userId: true },
  });
  const ids = new Set(enrolments.map((e) => e.userId));
  if (cls.coachUserId) ids.add(cls.coachUserId);
  return [...ids];
}

export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const token = request.cookies.get("kca_access_token")?.value;
  if (!token) return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });

  let payload: ReturnType<typeof verifyAccessToken>;
  try {
    payload = verifyAccessToken(token);
  } catch {
    return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
  }

  // A failure below here is a server fault, not an auth failure. Returning 401
  // for it used to log every user out on a single database blip, silently.
  try {
    const { id } = await context.params;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ success: false, message: "Invalid request body" }, { status: 400 });
    }
    const parsed = updateClassSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, message: "Validation failed.", errors: parsed.error.flatten().fieldErrors },
        { status: 400 },
      );
    }

    const cls = await db.class.findUnique({
      where: { id },
      select: {
        id: true,
        title: true,
        status: true,
        startsAt: true,
        endsAt: true,
        batchId: true,
        coach: { select: { userId: true } },
      },
    });
    if (!cls) return NextResponse.json({ success: false, message: "Not found" }, { status: 404 });
    if (!(await canManageClass(payload, id))) {
      return NextResponse.json({ success: false, message: "Not found" }, { status: 404 });
    }

    // A class that has already been taught is history. Letting it be retitled or
    // moved would rewrite what the attendance rows and the coach-activity table
    // are describing.
    if (cls.status === "COMPLETED") {
      return NextResponse.json(
        { success: false, message: "That class has already been taught and cannot be changed." },
        { status: 409 },
      );
    }

    const { title, description, startsAt, endsAt, meetingUrl, status } = parsed.data;
    const nextStart = startsAt ? new Date(startsAt) : cls.startsAt;
    const nextEnd = endsAt ? new Date(endsAt) : cls.endsAt;
    if (nextEnd <= nextStart) {
      return NextResponse.json(
        { success: false, message: "A class must end after it starts.", errors: { endsAt: ["Must be after the start"] } },
        { status: 400 },
      );
    }

    // Restarting a cancelled class is fine; un-cancelling one that is live is not
    // a thing, and `status` cannot express it anyway (SCHEDULED | CANCELLED only).
    const updated = await db.class.update({
      where: { id },
      data: {
        ...(title !== undefined ? { title } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(startsAt !== undefined ? { startsAt: nextStart } : {}),
        ...(endsAt !== undefined ? { endsAt: nextEnd } : {}),
        ...(meetingUrl !== undefined ? { meetingUrl } : {}),
        ...(status !== undefined ? { status } : {}),
      },
      select: { id: true, title: true, status: true, startsAt: true, endsAt: true },
    });

    // Tell the people whose evening just changed. A silent reschedule is worse
    // than none — they turn up to an empty room.
    const moved = startsAt !== undefined || endsAt !== undefined;
    const cancelled = status === "CANCELLED" && cls.status !== "CANCELLED";
    if (moved || cancelled) {
      const when = updated.startsAt.toLocaleString();
      const audience = await audienceFor({ id: cls.id, batchId: cls.batchId, coachUserId: cls.coach?.userId ?? null });
      await createNotifications(
        audience
          // The person who made the change does not need to be told about it.
          .filter((userId) => userId !== payload.userId)
          .map((userId) => ({
            userId,
            type: "CLASS_REMINDER" as const,
            title: cancelled ? "Class cancelled" : "Class rescheduled",
            body: cancelled ? `${updated.title} is no longer happening.` : `${updated.title} — now ${when}`,
          })),
      );
    }

    await writeAuditLog({
      action: cancelled ? "class.cancel" : "class.update",
      userId: payload.userId,
      metadata: {
        classId: id,
        changed: Object.keys(parsed.data),
        // A head or HR acting on a class that belongs to a coach. Legitimate, and
        // worth being able to find afterwards.
        override: payload.role !== "COACH" && Boolean(cls.coach?.userId),
        coachUserId: cls.coach?.userId ?? null,
      },
      request,
    });

    return NextResponse.json({ success: true, class: updated });
  } catch (error) {
    console.error("[classes/[id]] PATCH failed:", error);
    return NextResponse.json({ success: false, message: "Something went wrong." }, { status: 500 });
  }
}

/**
 * Erase a class outright. HEAD only, and deliberately not offered to a coach:
 * cancelling is the tool for "this is not happening", and it leaves the students
 * a record of why their Tuesday disappeared. This is for rows created in error.
 */
export async function DELETE(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const token = request.cookies.get("kca_access_token")?.value;
  if (!token) return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });

  let payload: ReturnType<typeof verifyAccessToken>;
  try {
    payload = verifyAccessToken(token);
  } catch {
    return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
  }

  try {
    if (payload.role !== "HEAD") {
      return NextResponse.json(
        { success: false, message: "Only the head can delete a class. Cancel it instead." },
        { status: 403 },
      );
    }

    const { id } = await context.params;
    const cls = await db.class.findUnique({
      where: { id },
      select: { id: true, title: true, coach: { select: { userId: true } } },
    });
    if (!cls) return NextResponse.json({ success: false, message: "Not found" }, { status: 404 });

    // Attendance and per-class enrolments hang off this row; clear them first
    // rather than relying on a cascade that may not be configured for both.
    await db.classAttendance.deleteMany({ where: { classId: id } });
    await db.classEnrollment.deleteMany({ where: { classId: id } });
    await db.class.delete({ where: { id } });

    await writeAuditLog({
      action: "class.delete",
      userId: payload.userId,
      metadata: { classId: id, title: cls.title, coachUserId: cls.coach?.userId ?? null },
      request,
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("[classes/[id]] DELETE failed:", error);
    return NextResponse.json({ success: false, message: "Something went wrong." }, { status: 500 });
  }
}
