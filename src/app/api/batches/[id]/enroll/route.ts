import { NextRequest, NextResponse } from "next/server";
import { verifyAccessToken } from "@/lib/auth";
import { canManageBatch } from "@/lib/authz";
import { db } from "@/lib/db";
import { writeAuditLog } from "@/lib/audit";
import { enrollSchema } from "@/lib/validations/phase3";
import { createNotification } from "@/lib/notify";

/** Enroll a student into a batch (academy-managed — HR/HEAD only). */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const token = request.cookies.get("kca_access_token")?.value;
  if (!token) {
    return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
  }

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
    const parsed = enrollSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, message: "Validation failed.", errors: parsed.error.flatten().fieldErrors },
        { status: 400 },
      );
    }

    const { studentUserId, username } = parsed.data;
    // A coach enrols students into batches they run; staff into any batch. 404
    // rather than 403 for someone else's batch, so ids cannot be probed.
    const batch = await db.batch.findUnique({ where: { id }, select: { id: true, name: true } });
    if (!batch || !(await canManageBatch(payload, id))) {
      return NextResponse.json({ success: false, message: "Batch not found" }, { status: 404 });
    }

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
      return NextResponse.json({ success: false, message: "No active student with that name." }, { status: 404 });
    }

    // Idempotent: skip if already enrolled.
    const existing = await db.classEnrollment.findFirst({ where: { batchId: id, userId: student.id } });
    if (!existing) {
      await db.classEnrollment.create({ data: { batchId: id, userId: student.id } });
      await createNotification({
        userId: student.id,
        type: "SYSTEM",
        title: "Enrolled in a batch",
        body: `You've been enrolled in "${batch.name}".`,
      });
      await writeAuditLog({
        action: "batch.enroll",
        userId: payload.userId,
        metadata: { batchId: id, studentId: student.id },
        request,
      });
    }

    return NextResponse.json({ success: true, username: student.username, alreadyEnrolled: Boolean(existing) });
  } catch (error) {
    console.error("[batches/[id]/enroll] POST failed:", error);
    return NextResponse.json({ success: false, message: "Something went wrong." }, { status: 500 });
  }
}
