import { NextRequest, NextResponse } from "next/server";
import { verifyAccessToken } from "@/lib/auth";
import { requireRole } from "@/lib/authz";
import { db } from "@/lib/db";
import { createClassSchema } from "@/lib/validations/phase3";
import { coachProfileIdForUser } from "../batches/route";
import { createNotifications } from "@/lib/notify";
import { writeAuditLog } from "@/lib/audit";

type ClassRow = {
  id: string;
  title: string;
  description: string | null;
  startsAt: Date;
  endsAt: Date;
  meetingUrl: string | null;
  batch: { name: string } | null;
  coach: { user: { username: string } } | null;
};

function shape(rows: ClassRow[]) {
  return rows.map((c) => ({
    id: c.id,
    title: c.title,
    description: c.description,
    startsAt: c.startsAt,
    endsAt: c.endsAt,
    meetingUrl: c.meetingUrl,
    batchName: c.batch?.name ?? null,
    coachName: c.coach?.user.username ?? null,
  }));
}

// `select` rather than `include` on the coach: only the username is rendered
// (see `shape`), and `include` pulled every CoachProfile column with it.
const CLASS_INCLUDE = {
  batch: { select: { name: true } },
  coach: { select: { user: { select: { username: true } } } },
} as const;

/** Upper bound on a schedule listing, so the query cannot grow without limit. */
const CLASS_PAGE_SIZE = 200;

async function batchIdsForStudents(studentIds: string[]): Promise<string[]> {
  if (studentIds.length === 0) return [];
  const enrollments = await db.classEnrollment.findMany({
    where: { userId: { in: studentIds }, batchId: { not: null } },
    select: { batchId: true },
  });
  return [...new Set(enrollments.map((e) => e.batchId).filter((b): b is string => Boolean(b)))];
}

export async function GET(request: NextRequest) {
  const token = request.cookies.get("kca_access_token")?.value;
  if (!token) {
    return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
  }

  try {
    const payload = verifyAccessToken(token);
    const now = new Date();
    const upcoming = { endsAt: { gte: now } };

    if (payload.role === "HR" || payload.role === "HEAD") {
      const rows = await db.class.findMany({ where: upcoming, include: CLASS_INCLUDE, orderBy: { startsAt: "asc" }, take: CLASS_PAGE_SIZE });
      return NextResponse.json({ success: true, classes: shape(rows) });
    }

    if (payload.role === "COACH") {
      const rows = await db.class.findMany({
        where: { ...upcoming, coach: { userId: payload.userId } },
        include: CLASS_INCLUDE,
        orderBy: { startsAt: "asc" },
        take: CLASS_PAGE_SIZE,
      });
      return NextResponse.json({ success: true, classes: shape(rows) });
    }

    if (payload.role === "STUDENT") {
      const batchIds = await batchIdsForStudents([payload.userId]);
      const rows = await db.class.findMany({
        where: { ...upcoming, batchId: { in: batchIds } },
        include: CLASS_INCLUDE,
        orderBy: { startsAt: "asc" },
        take: CLASS_PAGE_SIZE,
      });
      return NextResponse.json({ success: true, classes: shape(rows) });
    }

    // PARENT — their children's classes. Log the access (DPDPA: minor data).
    const links = await db.parentStudent.findMany({ where: { parentId: payload.userId }, select: { studentId: true } });
    const studentIds = links.map((l) => l.studentId);
    await writeAuditLog({
      action: "PARENT_VIEW_CHILD_SCHEDULE",
      userId: payload.userId,
      metadata: { studentIds },
      request,
    });
    const batchIds = await batchIdsForStudents(studentIds);
    const rows = await db.class.findMany({
      where: { ...upcoming, batchId: { in: batchIds } },
      include: CLASS_INCLUDE,
      orderBy: { startsAt: "asc" },
      take: CLASS_PAGE_SIZE,
    });
    return NextResponse.json({ success: true, classes: shape(rows) });
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

    const parsed = createClassSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, message: "Validation failed.", errors: parsed.error.flatten().fieldErrors },
        { status: 400 },
      );
    }
    const { batchId, title, description, coachUserId, startsAt, endsAt, meetingUrl } = parsed.data;

    const batch = await db.batch.findUnique({ where: { id: batchId }, select: { id: true, coachId: true } });
    if (!batch) {
      return NextResponse.json({ success: false, message: "Batch not found" }, { status: 404 });
    }

    const coachId = coachUserId ? await coachProfileIdForUser(coachUserId) : batch.coachId;

    const created = await db.class.create({
      data: {
        batchId,
        coachId,
        title,
        description,
        startsAt: new Date(startsAt),
        endsAt: new Date(endsAt),
        meetingUrl: meetingUrl || null,
        status: "SCHEDULED",
      },
    });

    // Notify enrolled students + the coach. The enrollment list and the coach
    // lookup are independent, so they overlap; the fan-out is then a single
    // insert rather than one round trip per student.
    const when = new Date(startsAt).toLocaleString();
    const [enrollments, coach] = await Promise.all([
      db.classEnrollment.findMany({ where: { batchId }, select: { userId: true } }),
      coachId
        ? db.coachProfile.findUnique({ where: { id: coachId }, select: { userId: true } })
        : Promise.resolve(null),
    ]);

    await createNotifications([
      ...enrollments.map((e) => ({
        userId: e.userId,
        type: "CLASS_REMINDER" as const,
        title: "New class scheduled",
        body: `${title} — ${when}`,
      })),
      ...(coach
        ? [
            {
              userId: coach.userId,
              type: "CLASS_REMINDER" as const,
              title: "New class assigned",
              body: `${title} — ${when}`,
            },
          ]
        : []),
    ]);

    return NextResponse.json({ success: true, class: created });
  } catch {
    return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
  }
}
