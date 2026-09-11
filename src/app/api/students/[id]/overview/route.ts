import { NextRequest, NextResponse } from "next/server";
import { verifyAccessToken } from "@/lib/auth";
import { canViewStudent, canViewMoney } from "@/lib/authz";
import { db } from "@/lib/db";
import { writeAuditLog } from "@/lib/audit";

export const runtime = "nodejs";

/**
 * Everything one student's progress page needs, for whoever is allowed to see it.
 *
 * The existing progress APIs are self-scoped (`where: { userId: payload.userId }`),
 * so a parent asking for reports got their own empty list rather than their
 * child's. This is the scoped read path: authorisation is `canViewStudent`, which
 * is the single shared rule (self / own child / own student / staff).
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const token = request.cookies.get("kca_access_token")?.value;
  if (!token) return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });

  let payload;
  try {
    payload = verifyAccessToken(token);
  } catch {
    return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
  }

  const { id: studentId } = await params;

  // 404 rather than 403 — a 403 confirms the id belongs to a real student.
  if (!(await canViewStudent(payload, studentId))) {
    return NextResponse.json({ success: false, message: "Not found" }, { status: 404 });
  }

  const student = await db.user.findUnique({
    where: { id: studentId },
    select: { id: true, username: true, email: true, role: true, createdAt: true },
  });
  if (!student || student.role !== "STUDENT") {
    return NextResponse.json({ success: false, message: "Not found" }, { status: 404 });
  }

  // Fees are the head's, the student's and their parent's — never a coach's.
  const showMoney = await canViewMoney(payload, studentId);

  const [ratings, games, reports, enrolments, attendance, payments] = await Promise.all([
    db.rating.findMany({
      where: { userId: studentId },
      select: { format: true, rating: true, updatedAt: true },
      orderBy: { rating: "desc" },
    }),
    db.game.findMany({
      where: { OR: [{ whiteUserId: studentId }, { blackUserId: studentId }] },
      orderBy: { playedAt: "desc" },
      take: 10,
      select: {
        id: true,
        result: true,
        timeFormat: true,
        playedAt: true,
        whiteUser: { select: { id: true, username: true } },
        blackUser: { select: { id: true, username: true } },
      },
    }),
    db.gameReport.findMany({
      where: { userId: studentId },
      orderBy: { createdAt: "desc" },
      take: 10,
      select: { id: true, status: true, gamesAnalyzed: true, createdAt: true, summary: true },
    }),
    db.classEnrollment.findMany({
      where: { userId: studentId },
      select: {
        batch: { select: { id: true, name: true } },
        class: { select: { id: true, title: true, startsAt: true, endsAt: true, status: true } },
      },
    }),
    db.classAttendance.findMany({
      where: { userId: studentId },
      orderBy: { markedAt: "desc" },
      take: 30,
      select: {
        id: true,
        status: true,
        markedAt: true,
        class: { select: { id: true, title: true, startsAt: true } },
      },
    }),
    // A coach passes canViewStudent — they teach this child — but must not see
    // what the family pays. Fetch nothing rather than fetch-and-filter, so the
    // rows never reach this process for someone who may not have them.
    showMoney
      ? db.payment.findMany({
          where: { userId: studentId },
          orderBy: { createdAt: "desc" },
          take: 20,
          select: {
            id: true,
            amount: true,
            currency: true,
            status: true,
            method: true,
            description: true,
            dueDate: true,
            paidAt: true,
            createdAt: true,
          },
        })
      : Promise.resolve([]),
  ]);

  const present = attendance.filter((a) => a.status === "PRESENT" || a.status === "LATE").length;

  // Reading a minor's records is exactly what the DPDPA audit trail is for. Only
  // log third-party access — a student reading their own page is not a disclosure.
  if (payload.userId !== studentId) {
    await writeAuditLog({
      action: "student.overview.view",
      userId: payload.userId,
      metadata: { studentId, viewerRole: payload.role },
      request,
    }).catch(() => {});
  }

  return NextResponse.json({
    success: true,
    student,
    ratings: ratings.map((r) => ({ ...r, rating: r.rating })),
    games,
    reports,
    batches: enrolments.map((e) => e.batch).filter(Boolean),
    classes: enrolments.map((e) => e.class).filter(Boolean),
    attendance,
    attendanceSummary: { total: attendance.length, present, rate: attendance.length ? Math.round((present / attendance.length) * 100) : null },
    showMoney,
    payments: payments.map((p) => ({ ...p, amount: Number(p.amount) })),
  });
}
