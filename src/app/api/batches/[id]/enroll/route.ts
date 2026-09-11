import { NextRequest, NextResponse } from "next/server";
import { verifyAccessToken } from "@/lib/auth";
import { requireRole } from "@/lib/authz";
import { db } from "@/lib/db";
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
    const denied = requireRole(payload, ["HR", "HEAD"]);
    if (denied) return denied;

    const { id } = await context.params;
    const parsed = enrollSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, message: "Validation failed.", errors: parsed.error.flatten().fieldErrors },
        { status: 400 },
      );
    }

    const { studentUserId } = parsed.data;
    const batch = await db.batch.findUnique({ where: { id }, select: { id: true, name: true } });
    if (!batch) {
      return NextResponse.json({ success: false, message: "Batch not found" }, { status: 404 });
    }

    // Idempotent: skip if already enrolled.
    const existing = await db.classEnrollment.findFirst({ where: { batchId: id, userId: studentUserId } });
    if (!existing) {
      await db.classEnrollment.create({ data: { batchId: id, userId: studentUserId } });
      await createNotification({
        userId: studentUserId,
        type: "SYSTEM",
        title: "Enrolled in a batch",
        body: `You've been enrolled in "${batch.name}".`,
      });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("[batches/[id]/enroll] POST failed:", error);
    return NextResponse.json({ success: false, message: "Something went wrong." }, { status: 500 });
  }
}
