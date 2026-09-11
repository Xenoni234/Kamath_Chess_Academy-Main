import { NextRequest, NextResponse } from "next/server";
import { verifyAccessToken } from "@/lib/auth";
import { requireRole } from "@/lib/authz";
import { db } from "@/lib/db";
import { writeAuditLog } from "@/lib/audit";
import { parentLinkSchema } from "@/lib/validations/admin";

export const runtime = "nodejs";

/**
 * Link a parent to a child, or remove the link.
 *
 * `ParentStudent` previously had read paths only, so no link could ever exist and
 * the entire PARENT role rendered zeroes. This is the write side.
 */
async function authorise(request: NextRequest) {
  const token = request.cookies.get("kca_access_token")?.value;
  if (!token) return { error: NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 }) };
  try {
    const payload = verifyAccessToken(token);
    const denied = requireRole(payload, ["HR", "HEAD"]);
    if (denied) return { error: denied };
    return { payload };
  } catch {
    return { error: NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 }) };
  }
}

export async function POST(request: NextRequest) {
  const { payload, error } = await authorise(request);
  if (error) return error;

  const body = await request.json().catch(() => null);
  const parsed = parentLinkSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ success: false, message: "Validation failed." }, { status: 400 });
  }
  const { parentId, studentId } = parsed.data;

  const [parent, student] = await Promise.all([
    db.user.findUnique({ where: { id: parentId }, select: { id: true, role: true } }),
    db.user.findUnique({ where: { id: studentId }, select: { id: true, role: true } }),
  ]);

  if (!parent || !student) {
    return NextResponse.json({ success: false, message: "Account not found" }, { status: 404 });
  }
  if (parent.role !== "PARENT") {
    return NextResponse.json({ success: false, message: "That account is not a parent." }, { status: 400 });
  }
  if (student.role !== "STUDENT") {
    return NextResponse.json({ success: false, message: "That account is not a student." }, { status: 400 });
  }

  await db.parentStudent.upsert({
    where: { parentId_studentId: { parentId, studentId } },
    create: { parentId, studentId },
    update: {},
  });

  await writeAuditLog({
    action: "admin.parentLink.create",
    userId: payload!.userId,
    metadata: { parentId, studentId },
    request,
  });

  return NextResponse.json({ success: true }, { status: 201 });
}

export async function DELETE(request: NextRequest) {
  const { payload, error } = await authorise(request);
  if (error) return error;

  const body = await request.json().catch(() => null);
  const parsed = parentLinkSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ success: false, message: "Validation failed." }, { status: 400 });
  }
  const { parentId, studentId } = parsed.data;

  await db.parentStudent
    .delete({ where: { parentId_studentId: { parentId, studentId } } })
    .catch(() => {});

  await writeAuditLog({
    action: "admin.parentLink.delete",
    userId: payload!.userId,
    metadata: { parentId, studentId },
    request,
  });

  return NextResponse.json({ success: true });
}
