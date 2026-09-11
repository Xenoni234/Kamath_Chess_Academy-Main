/**
 * Add a student to one class, from inside the class.
 *
 * Distinct from `/api/batches/[id]/enroll`, and deliberately so. A batch
 * enrolment means "this student attends this coach's classes from now on"; this
 * one means "this student is in the room today". A student who drops into a
 * single session should not silently join the batch, and a coach mid-class should
 * not have to leave for the Scheduling page to mark them present.
 *
 * Enrolment is what makes someone markable: `GET /api/attendance` builds its
 * roster from enrolments, so without this the coach can see a student in the
 * video call and have nowhere to record them.
 *
 * Permission mirrors attendance exactly — the coach of this class, or HR/HEAD.
 * Anything else is 404, not 403, so class ids stay unprobeable.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { verifyAccessToken } from "@/lib/auth";
import { canManageClass } from "@/lib/authz";
import { db } from "@/lib/db";
import { createNotification } from "@/lib/notify";
import { writeAuditLog } from "@/lib/audit";

export const runtime = "nodejs";

/**
 * Either an id (staff picked from the list) or an exact username.
 *
 * The username path exists for coaches. `/api/students` scopes a coach to their
 * own roster, so the dropdown could only ever offer students they already teach —
 * which made adding a walk-in impossible, the one case the feature is for.
 *
 * Exact match, never a search: returning partial matches would let any coach
 * enumerate the academy's students a letter at a time. A coach who can name the
 * student in front of them can add them; nobody can go fishing.
 */
const enrollSchema = z
  .object({
    studentUserId: z.string().min(1).optional(),
    username: z.string().trim().min(1).max(20).optional(),
  })
  .refine((v) => Boolean(v.studentUserId || v.username), { message: "Pick a student" });

/** The coach of this class, or academy staff. Same rule as marking attendance. */

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const token = request.cookies.get("kca_access_token")?.value;
  if (!token) return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });

  let payload: ReturnType<typeof verifyAccessToken>;
  try {
    payload = verifyAccessToken(token);
  } catch {
    return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
  }

  try {
    const { id } = await context.params;

    const cls = await db.class.findUnique({ where: { id }, select: { id: true, title: true, batchId: true } });
    if (!cls) return NextResponse.json({ success: false, message: "Not found" }, { status: 404 });
    if (!(await canManageClass(payload, id))) {
      return NextResponse.json({ success: false, message: "Not found" }, { status: 404 });
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ success: false, message: "Invalid request body" }, { status: 400 });
    }

    const parsed = enrollSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, message: "Validation failed.", errors: parsed.error.flatten().fieldErrors },
        { status: 400 },
      );
    }
    const { studentUserId, username } = parsed.data;

    const student = studentUserId
      ? await db.user.findUnique({
          where: { id: studentUserId },
          select: { id: true, username: true, role: true, isActive: true },
        })
      : await db.user.findFirst({
          where: { username: { equals: username!, mode: "insensitive" } },
          select: { id: true, username: true, role: true, isActive: true },
        });
    if (!student || student.role !== "STUDENT" || !student.isActive) {
      // One message for "no such person" and "not a student", so this cannot be
      // used to find out who has an account.
      return NextResponse.json(
        { success: false, message: "No active student with that name." },
        { status: 404 },
      );
    }

    // Already in the room's roster? Either directly, or through the batch — in
    // which case adding a second row would duplicate them in the attendance list.
    const existing = await db.classEnrollment.findFirst({
      where: {
        userId: student.id,
        OR: [{ classId: id }, ...(cls.batchId ? [{ batchId: cls.batchId }] : [])],
      },
      select: { id: true },
    });
    if (existing) {
      return NextResponse.json({ success: true, alreadyEnrolled: true, username: student.username });
    }

    await db.classEnrollment.create({ data: { classId: id, userId: student.id } });

    await createNotification({
      userId: student.id,
      type: "CLASS_REMINDER",
      title: "Added to a class",
      body: `You've been added to "${cls.title}".`,
    }).catch(() => {});

    await writeAuditLog({
      action: "class.enroll",
      userId: payload.userId,
      metadata: { classId: id, studentId: student.id },
      request,
    });

    return NextResponse.json({ success: true, username: student.username });
  } catch (error) {
    console.error("[classes/[id]/enroll] POST failed:", error);
    return NextResponse.json({ success: false, message: "Something went wrong." }, { status: 500 });
  }
}
