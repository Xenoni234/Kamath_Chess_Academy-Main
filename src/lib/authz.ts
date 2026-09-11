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
