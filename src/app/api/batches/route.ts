import { NextRequest, NextResponse } from "next/server";
import { verifyAccessToken } from "@/lib/auth";
import { requireRole } from "@/lib/authz";
import { db } from "@/lib/db";
import { writeAuditLog } from "@/lib/audit";
import { createBatchSchema } from "@/lib/validations/phase3";

/** Resolve a COACH user to their CoachProfile id, creating the profile if needed. */
export async function coachProfileIdForUser(coachUserId: string): Promise<string> {
  const profile = await db.coachProfile.upsert({
    where: { userId: coachUserId },
    create: { userId: coachUserId },
    update: {},
    select: { id: true },
  });
  return profile.id;
}

export async function GET(request: NextRequest) {
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
    // HR/HEAD see every batch; a coach sees only batches assigned to them.
    const isManager = payload.role === "HR" || payload.role === "HEAD";
    if (!isManager && payload.role !== "COACH") {
      return NextResponse.json({ success: false, message: "Forbidden" }, { status: 403 });
    }

    const batches = await db.batch.findMany({
      where: isManager ? {} : { coach: { userId: payload.userId } },
      include: {
        // `select` on the coach: only the nested user id/username is rendered,
        // so `include` was pulling every CoachProfile column alongside it.
        coach: { select: { user: { select: { id: true, username: true } } } },
        _count: { select: { classes: true, enrollments: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 200,
    });

    return NextResponse.json({
      success: true,
      batches: batches.map((batch) => ({
        id: batch.id,
        name: batch.name,
        description: batch.description,
        coach: batch.coach ? { userId: batch.coach.user.id, username: batch.coach.user.username } : null,
        classCount: batch._count.classes,
        studentCount: batch._count.enrollments,
      })),
    });
  } catch (error) {
    console.error("[batches] GET failed:", error);
    return NextResponse.json({ success: false, message: "Something went wrong." }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
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
    // A coach may form a group of their own students — that is teaching, not
    // administration. The one thing they cannot do is create it under somebody
    // else's name, so `coachUserId` is ignored for a coach and forced to self.
    const denied = requireRole(payload, ["HR", "HEAD", "COACH"]);
    if (denied) return denied;

    const parsed = createBatchSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, message: "Validation failed.", errors: parsed.error.flatten().fieldErrors },
        { status: 400 },
      );
    }

    const { name, description } = parsed.data;
    const coachUserId = payload.role === "COACH" ? payload.userId : parsed.data.coachUserId;
    const coachId = coachUserId ? await coachProfileIdForUser(coachUserId) : null;

    const batch = await db.batch.create({ data: { name, description, coachId } });

    await writeAuditLog({
      action: "batch.create",
      userId: payload.userId,
      metadata: { batchId: batch.id, name, coachUserId: coachUserId ?? null },
      request,
    });

    return NextResponse.json({ success: true, batch });
  } catch (error) {
    console.error("[batches] POST failed:", error);
    return NextResponse.json({ success: false, message: "Something went wrong." }, { status: 500 });
  }
}
