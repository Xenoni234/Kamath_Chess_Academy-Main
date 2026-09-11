import { NextRequest, NextResponse } from "next/server";
import { verifyAccessToken } from "@/lib/auth";
import { requireRole } from "@/lib/authz";
import type { ClassStatus } from "@prisma/client";
import { db } from "@/lib/db";
import { createClassSchema } from "@/lib/validations/phase3";
import { coachProfileIdForUser } from "../batches/route";
import { createNotifications } from "@/lib/notify";
import { writeAuditLog } from "@/lib/audit";

type ClassRow = {
  id: string;
  title: string;
  description: string | null;
  status: ClassStatus;
  startsAt: Date;
  endsAt: Date;
  meetingUrl: string | null;
  batch: { name: string } | null;
  coach: { user: { username: string } } | null;
};

/**
 * `canManage` says whether this viewer may move or cancel the class, so the page
 * can offer the controls the server would actually honour — the mismatch that
 * previously let the head see buttons the API refused.
 *
 * It is a role flag rather than a per-row lookup because the scope below has
 * already done the work: a coach's list contains only classes they coach, and
 * HR/HEAD may manage anything. A student or parent never can.
 */
function shape(rows: ClassRow[], canManage: boolean) {
  return rows.map((c) => ({
    id: c.id,
    title: c.title,
    description: c.description,
    status: c.status,
    startsAt: c.startsAt,
    endsAt: c.endsAt,
    meetingUrl: c.meetingUrl,
    batchName: c.batch?.name ?? null,
    coachName: c.coach?.user.username ?? null,
    canManage,
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

/**
 * Which of the three lists a class belongs in.
 *
 * Status first, clock second — and that ordering is the fix for a real bug. The
 * filter used to be purely `endsAt >= now`, so a class the coach had explicitly
 * ENDED still sat under "Upcoming" until its scheduled finish time passed. The
 * coach pressed End class, watched the room close, and then saw the same class
 * advertised as upcoming.
 *
 * A class that was scheduled and simply never started is "ended" once its time
 * has passed. It is not upcoming — nobody is going to attend it now — and
 * leaving it in the upcoming list buries the classes that really are next.
 */
function bucketsFor(now: Date) {
  return {
    ongoing: { status: "ONGOING" as const },
    upcoming: { status: "SCHEDULED" as const, endsAt: { gte: now } },
    ended: {
      OR: [
        { status: { in: ["COMPLETED", "CANCELLED"] as ClassStatus[] } },
        { status: "SCHEDULED" as const, endsAt: { lt: now } },
      ],
    },
  };
}

/** How far back the "ended" list reaches. Older than this is history, not a list. */
const ENDED_PAGE_SIZE = 50;

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

  let payload: ReturnType<typeof verifyAccessToken>;
  try {
    payload = verifyAccessToken(token);
  } catch {
    return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
  }

  // A failure below here is a server fault, not an auth failure. Returning 401
  // for it used to log every user out on a single database blip, silently.
  try {
    const now = new Date();
    const buckets = bucketsFor(now);
    const canManage =
      payload.role === "HR" || payload.role === "HEAD" || payload.role === "COACH";

    /**
     * The role's own scope — the filter that decides WHICH classes this person
     * may see at all. Combined with a bucket to answer "which of theirs are on
     * now, next, and done".
     */
    let scope: Record<string, unknown>;

    if (payload.role === "HR" || payload.role === "HEAD") {
      scope = {};
    } else if (payload.role === "COACH") {
      scope = { coach: { userId: payload.userId } };
    } else if (payload.role === "STUDENT") {
      scope = { batchId: { in: await batchIdsForStudents([payload.userId]) } };
    } else {
      // PARENT — their children's classes. Log the access (DPDPA: minor data).
      const links = await db.parentStudent.findMany({
        where: { parentId: payload.userId },
        select: { studentId: true },
      });
      const studentIds = links.map((l) => l.studentId);
      await writeAuditLog({
        action: "PARENT_VIEW_CHILD_SCHEDULE",
        userId: payload.userId,
        metadata: { studentIds },
        request,
      });
      scope = { batchId: { in: await batchIdsForStudents(studentIds) } };
    }

    const [ongoing, upcoming, ended] = await Promise.all([
      db.class.findMany({
        where: { ...scope, ...buckets.ongoing },
        include: CLASS_INCLUDE,
        orderBy: { startsAt: "asc" },
        take: CLASS_PAGE_SIZE,
      }),
      db.class.findMany({
        where: { ...scope, ...buckets.upcoming },
        include: CLASS_INCLUDE,
        orderBy: { startsAt: "asc" },
        take: CLASS_PAGE_SIZE,
      }),
      db.class.findMany({
        // Newest first: the class that just finished is the one being looked for.
        where: { ...scope, ...buckets.ended },
        include: CLASS_INCLUDE,
        orderBy: { startsAt: "desc" },
        take: ENDED_PAGE_SIZE,
      }),
    ]);

    return NextResponse.json({
      success: true,
      ongoing: shape(ongoing, canManage),
      upcoming: shape(upcoming, canManage),
      ended: shape(ended, canManage),
      // Kept so nothing that still reads `classes` breaks: it is what the page
      // used to render, i.e. everything not yet finished.
      classes: shape([...ongoing, ...upcoming], canManage),
    });
  } catch (error) {
    console.error("[classes] GET failed:", error);
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
    // Coaches may schedule sessions for batches they actually run; the ownership
    // check happens below, once we know which batch. Anyone else is refused here.
    const denied = requireRole(payload, ["HR", "HEAD", "COACH"]);
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

    // A coach may only schedule into their own batch, and may not assign the
    // class to somebody else — otherwise "coach can create classes" becomes
    // "any coach can put a session in any batch, under any colleague's name".
    if (payload.role === "COACH") {
      const ownProfile = await db.coachProfile.findUnique({
        where: { userId: payload.userId },
        select: { id: true },
      });
      if (!ownProfile || batch.coachId !== ownProfile.id) {
        return NextResponse.json({ success: false, message: "Batch not found" }, { status: 404 });
      }
      if (coachUserId && coachUserId !== payload.userId) {
        return NextResponse.json(
          { success: false, message: "You can only schedule classes for yourself." },
          { status: 403 },
        );
      }
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
  } catch (error) {
    console.error("[classes] POST failed:", error);
    return NextResponse.json({ success: false, message: "Something went wrong." }, { status: 500 });
  }
}
