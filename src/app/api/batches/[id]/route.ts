import { NextRequest, NextResponse } from "next/server";
import { verifyAccessToken } from "@/lib/auth";
import { requireRole } from "@/lib/authz";
import { db } from "@/lib/db";
import { assignCoachSchema } from "@/lib/validations/phase3";
import { coachProfileIdForUser } from "../route";
import { createNotification } from "@/lib/notify";

/** Assign or reassign a coach to a batch. */
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
    const denied = requireRole(payload, ["HR", "HEAD"]);
    if (denied) return denied;

    const { id } = await context.params;
    const parsed = assignCoachSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, message: "Validation failed.", errors: parsed.error.flatten().fieldErrors },
        { status: 400 },
      );
    }

    const batch = await db.batch.findUnique({ where: { id }, select: { id: true, name: true } });
    if (!batch) {
      return NextResponse.json({ success: false, message: "Batch not found" }, { status: 404 });
    }

    const coachId = await coachProfileIdForUser(parsed.data.coachUserId);
    await db.batch.update({ where: { id }, data: { coachId } });

    await createNotification({
      userId: parsed.data.coachUserId,
      type: "SYSTEM",
      title: "You've been assigned a batch",
      body: `You are now the coach for "${batch.name}".`,
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("[batches/[id]] PATCH failed:", error);
    return NextResponse.json({ success: false, message: "Something went wrong." }, { status: 500 });
  }
}
