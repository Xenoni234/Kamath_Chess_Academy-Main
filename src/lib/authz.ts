import { NextResponse } from "next/server";
import type { Role } from "@prisma/client";
import { db } from "@/lib/db";

/**
 * Role-based authorization for API routes. Routes authenticate with
 * `verifyAccessToken` (which never checks role) — this adds the role gate.
 *
 * Usage in a route handler, after verifying the token:
 *
 *   const denied = requireRole(payload, ["HR", "HEAD"]);
 *   if (denied) return denied;
 *
 * Returns a ready-to-return 403 JSON response when the role isn't allowed, or
 * `null` when the user may proceed.
 */
export function requireRole(payload: { role: Role }, allowed: Role[]): NextResponse | null {
  if (!allowed.includes(payload.role)) {
    return NextResponse.json(
      { success: false, message: "You do not have permission to perform this action." },
      { status: 403 },
    );
  }
  return null;
}

/** Boolean variant for server components / data filtering (no HTTP response). */
export function hasRole(role: Role, allowed: Role[]): boolean {
  return allowed.includes(role);
}

// ---------------------------------------------------------------------------
// Relationship authorization
//
// Role alone does not answer "may this person see THIS student". A parent may
// only see their own child; a coach only students in a batch they run. These
// live here so every scoped route shares one rule instead of re-deriving it —
// the kind of duplication where one route eventually gets it wrong.
// ---------------------------------------------------------------------------

/** Is `studentId` a child of `parentId`? */
export async function isParentOf(parentId: string, studentId: string): Promise<boolean> {
  const link = await db.parentStudent.findUnique({
    where: { parentId_studentId: { parentId, studentId } },
    select: { id: true },
  });
  return Boolean(link);
}

/** Is `studentId` enrolled in any batch or class run by this coach? */
export async function isCoachOf(coachUserId: string, studentId: string): Promise<boolean> {
  const coach = await db.coachProfile.findUnique({
    where: { userId: coachUserId },
    select: { id: true },
  });
  if (!coach) return false;

  const enrolment = await db.classEnrollment.findFirst({
    where: {
      userId: studentId,
      OR: [{ batch: { coachId: coach.id } }, { class: { coachId: coach.id } }],
    },
    select: { id: true },
  });
  return Boolean(enrolment);
}

/**
 * May this caller read `studentId`'s data?
 *
 * Themselves, their own child, their own student, or staff. Everything that
 * exposes a student's games/reports/attendance/payments must go through this.
 */
export async function canViewStudent(
  viewer: { userId: string; role: Role },
  studentId: string,
): Promise<boolean> {
  if (viewer.userId === studentId) return true;
  if (viewer.role === "HR" || viewer.role === "HEAD") return true;
  if (viewer.role === "PARENT") return isParentOf(viewer.userId, studentId);
  if (viewer.role === "COACH") return isCoachOf(viewer.userId, studentId);
  return false;
}

/** Students a coach may see, via their batches and classes. */
export async function studentIdsForCoach(coachUserId: string): Promise<string[]> {
  const coach = await db.coachProfile.findUnique({
    where: { userId: coachUserId },
    select: { id: true },
  });
  if (!coach) return [];

  const rows = await db.classEnrollment.findMany({
    where: { OR: [{ batch: { coachId: coach.id } }, { class: { coachId: coach.id } }] },
    select: { userId: true },
  });
  return [...new Set(rows.map((r) => r.userId))];
}

/** Children of a parent. */
export async function childIdsForParent(parentId: string): Promise<string[]> {
  const rows = await db.parentStudent.findMany({ where: { parentId }, select: { studentId: true } });
  return rows.map((r) => r.studentId);
}

/**
 * Who may SEE a student's fees, invoices and payment history.
 *
 * Deliberately narrower than `canViewStudent`. That rule answers "may this person
 * see this student's chess", and it admits coaches — correctly, because a coach
 * needs the games, attendance and progress of everyone they teach.
 *
 * Money is not that. What a family pays the academy is between the family and the
 * academy's owner; a coach has no business seeing whether a student's fees are
 * overdue, and it colours how they treat the child. Using `canViewStudent` for
 * money surfaces is what leaked it.
 *
 * So: the academy head, the student themselves, and a linked parent. Not coaches,
 * and not HR — the academy's instruction is that fees are the head's alone.
 */
export async function canViewMoney(
  viewer: { userId: string; role: Role },
  studentId: string,
): Promise<boolean> {
  if (viewer.userId === studentId) return true;
  if (viewer.role === "HEAD") return true;
  if (viewer.role === "PARENT") return isParentOf(viewer.userId, studentId);
  return false;
}

/**
 * Who may RECORD or CHANGE money: the head, and nobody else.
 *
 * Separate from `canViewMoney` because a student may read their own fees and must
 * never be able to mark them paid.
 */
export function canManageMoney(viewer: { role: Role }): boolean {
  return viewer.role === "HEAD";
}

/**
 * Who may run a class: its own coach, or academy staff.
 *
 * A coach has full command of their own teaching — schedule it, retitle it, move
 * it, cancel it, start and end the room, mark who attended, add a walk-in. What
 * makes it safe to hand a coach that much is the word *own*: every one of those
 * powers is scoped to a class they are the coach of, so "a coach can run classes"
 * never becomes "any coach can reach into a colleague's batch".
 *
 * HR and the head are unscoped on purpose — **this is the override**. A coach is
 * ill an hour before a session, a class was scheduled into the wrong slot, a room
 * was left running overnight: somebody has to be able to act on a class that is
 * not theirs, and in this academy that is the head. The head's decision is final
 * over any coach's, which is exactly the asymmetry the academy asked for.
 *
 * Note what is NOT here: money. A coach who can do all of the above still cannot
 * see or touch a rupee — that goes through `canViewMoney` / `canManageMoney`, and
 * those admit only the head, the student, and a linked parent. Teaching authority
 * and financial authority are deliberately different questions.
 */
export async function canManageClass(
  viewer: { userId: string; role: Role },
  classId: string,
): Promise<boolean> {
  if (viewer.role === "HR" || viewer.role === "HEAD") return true;
  if (viewer.role !== "COACH") return false;
  const cls = await db.class.findUnique({
    where: { id: classId },
    select: { coach: { select: { userId: true } } },
  });
  return Boolean(cls && cls.coach?.userId === viewer.userId);
}

/** The same rule one level up: the batch's own coach, or academy staff. */
export async function canManageBatch(
  viewer: { userId: string; role: Role },
  batchId: string,
): Promise<boolean> {
  if (viewer.role === "HR" || viewer.role === "HEAD") return true;
  if (viewer.role !== "COACH") return false;
  const batch = await db.batch.findUnique({
    where: { id: batchId },
    select: { coach: { select: { userId: true } } },
  });
  return Boolean(batch && batch.coach?.userId === viewer.userId);
}

/**
 * Did this person act on something that was not theirs?
 *
 * Only used to tag the audit entry. A head editing a coach's class is legitimate
 * and routine, but it must be legible afterwards — "who moved my Tuesday class"
 * should have an answer.
 */
export function isOverride(viewer: { role: Role }, ownerUserId: string | null | undefined): boolean {
  return viewer.role !== "COACH" && Boolean(ownerUserId);
}
