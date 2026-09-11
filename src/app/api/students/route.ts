import { NextRequest, NextResponse } from "next/server";
import { verifyAccessToken } from "@/lib/auth";
import { childIdsForParent, studentIdsForCoach } from "@/lib/authz";
import { db } from "@/lib/db";

export const runtime = "nodejs";

/**
 * The students this caller may see: their children (parent), their roster
 * (coach), or everyone (staff). One endpoint so the parent and coach pages don't
 * each re-derive the relationship rules.
 */
export async function GET(request: NextRequest) {
  const token = request.cookies.get("kca_access_token")?.value;
  if (!token) return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });

  let payload;
  try {
    payload = verifyAccessToken(token);
  } catch {
    return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
  }

  let ids: string[] | null = null;
  if (payload.role === "PARENT") ids = await childIdsForParent(payload.userId);
  else if (payload.role === "COACH") ids = await studentIdsForCoach(payload.userId);
  else if (payload.role !== "HR" && payload.role !== "HEAD") ids = [payload.userId];

  const students = await db.user.findMany({
    where: { role: "STUDENT", ...(ids ? { id: { in: ids } } : {}) },
    orderBy: { username: "asc" },
    take: 300,
    select: {
      id: true,
      username: true,
      email: true,
      isActive: true,
      ratings: { select: { format: true, rating: true }, orderBy: { rating: "desc" }, take: 1 },
      classEnrollments: { select: { batch: { select: { id: true, name: true } } }, take: 5 },
    },
  });

  return NextResponse.json({
    success: true,
    students: students.map((s) => ({
      id: s.id,
      username: s.username,
      email: s.email,
      isActive: s.isActive,
      topRating: s.ratings[0]?.rating ?? null,
      batches: [...new Set(s.classEnrollments.map((e) => e.batch?.name).filter(Boolean))],
    })),
  });
}
