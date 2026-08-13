import { NextRequest, NextResponse } from "next/server";
import { verifyAccessToken } from "@/lib/auth";
import { requireRole } from "@/lib/authz";
import { db } from "@/lib/db";
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

  try {
    const payload = verifyAccessToken(token);
    // HR/HEAD see every batch; a coach sees only batches assigned to them.
    const isManager = payload.role === "HR" || payload.role === "HEAD";
    if (!isManager && payload.role !== "COACH") {
      return NextResponse.json({ success: false, message: "Forbidden" }, { status: 403 });
    }

    const batches = await db.batch.findMany({
      where: isManager ? {} : { coach: { userId: payload.userId } },
      include: {
        coach: { include: { user: { select: { id: true, username: true } } } },
        _count: { select: { classes: true, enrollments: true } },
      },
      orderBy: { createdAt: "desc" },
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
  } catch {
    return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
  }
}

export async function POST(request: NextRequest) {
  const token = request.cookies.get("kca_access_token")?.value;
  if (!token) {
    return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
  }

  try {
    const payload = verifyAccessToken(token);
    const denied = requireRole(payload, ["HR", "HEAD"]);
    if (denied) return denied;

    const parsed = createBatchSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, message: "Validation failed.", errors: parsed.error.flatten().fieldErrors },
        { status: 400 },
      );
    }

    const { name, description, coachUserId } = parsed.data;
    const coachId = coachUserId ? await coachProfileIdForUser(coachUserId) : null;

    const batch = await db.batch.create({ data: { name, description, coachId } });
    return NextResponse.json({ success: true, batch });
  } catch {
    return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
  }
}
