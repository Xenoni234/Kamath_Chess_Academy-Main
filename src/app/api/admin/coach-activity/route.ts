/**
 * How much teaching each coach has actually done.
 *
 * The academy could see who its coaches were and which batches they held, but
 * not whether they were turning up. Scheduled-vs-completed is the question a head
 * asks about a coach, and nothing answered it.
 *
 * "Completed" means the coach pressed End class — a deliberate act — rather than
 * "the clock passed its end time". A class that was scheduled and never started
 * is counted separately as `missed`, because those two are very different facts
 * about a coach and averaging them into one number hides the useful one.
 *
 * HR sees this too: they schedule the classes, so they need to know who is
 * carrying the load. It carries no fee or personal data — only counts.
 */
import { NextRequest, NextResponse } from "next/server";
import { verifyAccessToken } from "@/lib/auth";
import { requireRole } from "@/lib/authz";
import { db } from "@/lib/db";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const token = request.cookies.get("kca_access_token")?.value;
  if (!token) return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });

  let payload: ReturnType<typeof verifyAccessToken>;
  try {
    payload = verifyAccessToken(token);
  } catch {
    return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
  }

  try {
    const denied = requireRole(payload, ["HR", "HEAD"]);
    if (denied) return denied;

    const now = new Date();

    const coaches = await db.coachProfile.findMany({
      select: {
        id: true,
        user: { select: { id: true, username: true, isActive: true } },
        batches: { select: { id: true } },
      },
    });

    // One grouped count instead of a query per coach — a dozen coaches would
    // otherwise be a dozen round trips to Mumbai.
    const byStatus = await db.class.groupBy({
      by: ["coachId", "status"],
      _count: true,
      where: { coachId: { not: null } },
    });

    // Scheduled classes whose time has passed and which nobody ever started.
    const missedRows = await db.class.groupBy({
      by: ["coachId"],
      _count: true,
      where: { coachId: { not: null }, status: "SCHEDULED", endsAt: { lt: now } },
    });
    const missedByCoach = new Map(missedRows.map((r) => [r.coachId, r._count]));

    // Students reachable through each coach's batches.
    const enrolments = await db.classEnrollment.findMany({
      where: { batchId: { not: null } },
      select: { userId: true, batch: { select: { coachId: true } } },
    });
    const studentsByCoach = new Map<string, Set<string>>();
    for (const e of enrolments) {
      const coachId = e.batch?.coachId;
      if (!coachId) continue;
      if (!studentsByCoach.has(coachId)) studentsByCoach.set(coachId, new Set());
      studentsByCoach.get(coachId)!.add(e.userId);
    }

    const rows = coaches.map((coach) => {
      const counts = byStatus.filter((c) => c.coachId === coach.id);
      const of = (status: string) => counts.find((c) => c.status === status)?._count ?? 0;
      const completed = of("COMPLETED");
      const missed = missedByCoach.get(coach.id) ?? 0;
      const scheduled = of("SCHEDULED") - missed;

      return {
        userId: coach.user.id,
        username: coach.user.username,
        isActive: coach.user.isActive,
        batches: coach.batches.length,
        students: studentsByCoach.get(coach.id)?.size ?? 0,
        completed,
        ongoing: of("ONGOING"),
        // Still in the future.
        scheduled: Math.max(scheduled, 0),
        // Time passed, never started.
        missed,
        cancelled: of("CANCELLED"),
        total: counts.reduce((sum, c) => sum + c._count, 0),
      };
    });

    rows.sort((a, b) => b.completed - a.completed || a.username.localeCompare(b.username));

    return NextResponse.json({ success: true, coaches: rows });
  } catch (error) {
    console.error("[admin/coach-activity] GET failed:", error);
    return NextResponse.json({ success: false, message: "Something went wrong." }, { status: 500 });
  }
}
