import { NextRequest, NextResponse } from "next/server";
import { verifyAccessToken } from "@/lib/auth";
import { canManageBatch } from "@/lib/authz";
import { db } from "@/lib/db";
import { writeAuditLog } from "@/lib/audit";
import { updateBatchSchema } from "@/lib/validations/phase3";
import { coachProfileIdForUser } from "../route";
import { createNotification } from "@/lib/notify";

/**
 * Edit a batch: its name, its description, or which coach runs it.
 *
 * The batch's own coach may do the first two — naming and describing a group they
 * teach is part of teaching it. Reassigning the coach is the head's, and is
 * refused for a COACH below even though it shares this schema.
 */
export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string }> }) {
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
    const parsed = updateBatchSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, message: "Validation failed.", errors: parsed.error.flatten().fieldErrors },
        { status: 400 },
      );
    }

    // A coach may rename and describe a batch they run. Moving a batch to another
    // coach is an academy decision, not a teaching one — a coach who could set
    // `coachUserId` could hand their batch away, or take a colleague's.
    if (payload.role === "COACH" && parsed.data.coachUserId !== undefined) {
      return NextResponse.json(
        { success: false, message: "Only the head can change a batch's coach." },
        { status: 403 },
      );
    }

    const batch = await db.batch.findUnique({ where: { id }, select: { id: true, name: true } });
    // 404 before the ownership check would confirm the id exists; check both and
    // answer 404 either way.
    if (!batch || !(await canManageBatch(payload, id))) {
      return NextResponse.json({ success: false, message: "Batch not found" }, { status: 404 });
    }

    const { name, description, coachUserId } = parsed.data;
    const coachId = coachUserId ? await coachProfileIdForUser(coachUserId) : undefined;

    await db.batch.update({
      where: { id },
      data: {
        ...(name !== undefined ? { name } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(coachId !== undefined ? { coachId } : {}),
      },
    });

    if (coachUserId) {
      await createNotification({
        userId: coachUserId,
        type: "SYSTEM",
        title: "You've been assigned a batch",
        body: `You are now the coach for "${name ?? batch.name}".`,
      });
    }

    await writeAuditLog({
      action: "batch.update",
      userId: payload.userId,
      metadata: { batchId: id, changed: Object.keys(parsed.data) },
      request,
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("[batches/[id]] PATCH failed:", error);
    return NextResponse.json({ success: false, message: "Something went wrong." }, { status: 500 });
  }
}
