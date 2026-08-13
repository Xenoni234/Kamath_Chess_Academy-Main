import { db } from "./db";
import { writeAuditLog } from "./audit";

/** A single dashboard stat tile. `href` makes the whole card a link. */
export type StatCard = { label: string; value: string | number; hint?: string; href?: string };

/** Count of upcoming classes across the batches these students are enrolled in. */
async function upcomingClassCount(studentIds: string[]): Promise<number> {
  if (studentIds.length === 0) return 0;
  const enrollments = await db.classEnrollment.findMany({
    where: { userId: { in: studentIds }, batchId: { not: null } },
    select: { batchId: true },
  });
  const batchIds = [...new Set(enrollments.map((e) => e.batchId).filter((b): b is string => Boolean(b)))];
  if (batchIds.length === 0) return 0;
  return db.class.count({ where: { batchId: { in: batchIds }, endsAt: { gte: new Date() } } });
}

export async function getStudentCards(userId: string): Promise<StatCard[]> {
  const [games, solved, topRating, upcoming] = await Promise.all([
    db.game.count({ where: { OR: [{ whiteUserId: userId }, { blackUserId: userId }] } }),
    db.puzzleAttempt.count({ where: { userId, isCorrect: true } }),
    db.rating.findFirst({ where: { userId }, orderBy: { rating: "desc" }, select: { rating: true, format: true } }),
    upcomingClassCount([userId]),
  ]);
  return [
    { label: "Games Played", value: games, href: "/dashboard/games" },
    { label: "Puzzles Solved", value: solved, href: "/dashboard/puzzles" },
    { label: "Upcoming Classes", value: upcoming, href: "/dashboard/classes" },
    { label: "Top Rating", value: topRating?.rating ?? 1500, hint: topRating ? topRating.format.toLowerCase() : "unrated" },
  ];
}

export async function getCoachCards(userId: string): Promise<StatCard[]> {
  const [batchCount, classCount, batches] = await Promise.all([
    db.batch.count({ where: { coach: { userId } } }),
    db.class.count({ where: { coach: { userId }, endsAt: { gte: new Date() } } }),
    db.batch.findMany({ where: { coach: { userId } }, select: { id: true } }),
  ]);
  const batchIds = batches.map((b) => b.id);
  const students = batchIds.length
    ? await db.classEnrollment.findMany({ where: { batchId: { in: batchIds } }, select: { userId: true }, distinct: ["userId"] })
    : [];
  return [
    { label: "My Batches", value: batchCount },
    { label: "Upcoming Classes", value: classCount, href: "/dashboard/classes" },
    { label: "Students", value: students.length },
    { label: "Analysis Board", value: "Open", hint: "Review games", href: "/dashboard/analysis" },
  ];
}

export async function getParentCards(userId: string): Promise<StatCard[]> {
  const links = await db.parentStudent.findMany({ where: { parentId: userId }, select: { studentId: true } });
  const studentIds = links.map((l) => l.studentId);
  // DPDPA: record that a parent accessed their (minor) children's data.
  await writeAuditLog({ action: "PARENT_VIEW_DASHBOARD", userId, metadata: { studentIds } });

  const [upcoming, reports, payments, topRating] = await Promise.all([
    upcomingClassCount(studentIds),
    studentIds.length ? db.gameReport.count({ where: { userId: { in: studentIds } } }) : Promise.resolve(0),
    db.payment.count({ where: { userId } }),
    studentIds.length
      ? db.rating.findFirst({ where: { userId: { in: studentIds } }, orderBy: { rating: "desc" }, select: { rating: true } })
      : Promise.resolve(null),
  ]);
  return [
    { label: "Children", value: studentIds.length, hint: studentIds.length === 0 ? "None linked" : undefined },
    { label: "Upcoming Classes", value: upcoming, href: "/dashboard/classes" },
    { label: "Child's Top Rating", value: topRating?.rating ?? "—" },
    { label: "Reports", value: reports },
  ];
}

export async function getHrCards(): Promise<StatCard[]> {
  const now = new Date();
  const [students, classes, pendingPayments, tournaments] = await Promise.all([
    db.user.count({ where: { role: "STUDENT", isActive: true } }),
    db.class.count({ where: { endsAt: { gte: now } } }),
    db.payment.count({ where: { status: "PENDING" } }),
    db.tournament.count({ where: { status: { in: ["UPCOMING", "ONGOING"] } } }),
  ]);
  return [
    { label: "Active Students", value: students },
    { label: "Scheduled Classes", value: classes, href: "/dashboard/schedule" },
    { label: "Pending Payments", value: pendingPayments },
    { label: "Tournaments", value: tournaments },
  ];
}

export async function getHeadCards(): Promise<StatCard[]> {
  const [users, coaches, revenue, games] = await Promise.all([
    db.user.count(),
    db.user.count({ where: { role: "COACH" } }),
    db.payment.aggregate({ _sum: { amount: true }, where: { status: "COMPLETED" } }),
    db.game.count(),
  ]);
  const total = revenue._sum.amount ? revenue._sum.amount.toNumber() : 0;
  return [
    { label: "Total Users", value: users },
    { label: "Coaches", value: coaches },
    { label: "Revenue", value: `₹${total.toLocaleString("en-IN")}`, hint: "Completed payments" },
    { label: "Games Played", value: games },
  ];
}
