import { NextRequest, NextResponse } from "next/server";
import { verifyAccessToken } from "@/lib/auth";
import { requireRole } from "@/lib/authz";
import { db } from "@/lib/db";
import { writeAuditLog } from "@/lib/audit";
import { updateUserSchema } from "@/lib/validations/admin";

export const runtime = "nodejs";

/** Change a user's role, or activate/deactivate them. */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const token = request.cookies.get("kca_access_token")?.value;
  if (!token) return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });

  let payload;
  try {
    payload = verifyAccessToken(token);
  } catch {
    return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
  }

  const denied = requireRole(payload, ["HR", "HEAD"]);
  if (denied) return denied;

  const { id } = await params;
  const body = await request.json().catch(() => null);
  const parsed = updateUserSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, message: "Validation failed.", errors: parsed.error.flatten().fieldErrors },
      { status: 400 },
    );
  }

  const target = await db.user.findUnique({ where: { id }, select: { id: true, role: true, isActive: true } });
  if (!target) return NextResponse.json({ success: false, message: "Not found" }, { status: 404 });

  const { role, isActive } = parsed.data;

  // Locking yourself out of your own academy is not a recoverable mistake.
  if (target.id === payload.userId && (isActive === false || (role && role !== payload.role))) {
    return NextResponse.json(
      { success: false, message: "You cannot change your own role or deactivate yourself." },
      { status: 400 },
    );
  }

  // Role changes are HEAD-only, and HR may not touch staff accounts at all —
  // otherwise HR could deactivate the head and take over the academy.
  const targetIsStaff = target.role === "HR" || target.role === "HEAD";
  if (payload.role === "HR" && (role !== undefined || targetIsStaff)) {
    return NextResponse.json(
      { success: false, message: "Only the academy head can change roles or manage staff accounts." },
      { status: 403 },
    );
  }

  // Never leave the platform without an active HEAD.
  const losingAHead = target.role === "HEAD" && ((role && role !== "HEAD") || isActive === false);
  if (losingAHead) {
    const otherHeads = await db.user.count({
      where: { role: "HEAD", isActive: true, id: { not: target.id } },
    });
    if (otherHeads === 0) {
      return NextResponse.json(
        { success: false, message: "This is the only active head account — promote another first." },
        { status: 400 },
      );
    }
  }

  const user = await db.user.update({
    where: { id },
    data: { ...(role ? { role } : {}), ...(isActive !== undefined ? { isActive } : {}) },
    select: { id: true, username: true, email: true, role: true, isActive: true },
  });

  // A deactivated or demoted user must not keep an authenticated session.
  if (isActive === false || (role && role !== target.role)) {
    await db.userSession.deleteMany({ where: { userId: id } }).catch(() => {});
  }

  await writeAuditLog({
    action: "admin.user.update",
    userId: payload.userId,
    metadata: { targetUserId: id, from: { role: target.role, isActive: target.isActive }, to: { role, isActive } },
    request,
  });

  return NextResponse.json({ success: true, user });
}
