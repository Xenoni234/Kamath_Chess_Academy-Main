/**
 * The student's own parent code: read it, or replace it.
 *
 * Self-scoped and STUDENT-only. There is no `userId` parameter, because this
 * code is the thing that grants access to a student's records — an endpoint that
 * returned someone else's would hand out exactly what the code exists to protect.
 * Staff have their own route to link a parent (`/api/admin/parent-links`) and do
 * not need this one.
 *
 * Regenerating invalidates whatever was shared before, which is the recovery
 * path when a code is sent to the wrong person.
 */
import { NextRequest, NextResponse } from "next/server";
import { verifyAccessToken } from "@/lib/auth";
import { db } from "@/lib/db";
import { writeAuditLog } from "@/lib/audit";
import { getOrCreateParentCode, regenerateParentCode } from "@/lib/parentCode";

export const runtime = "nodejs";

function auth(request: NextRequest) {
  const token = request.cookies.get("kca_access_token")?.value;
  if (!token) return null;
  try {
    return verifyAccessToken(token);
  } catch {
    return null;
  }
}

export async function GET(request: NextRequest) {
  const payload = auth(request);
  if (!payload) return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });

  try {
    if (payload.role !== "STUDENT") {
      return NextResponse.json(
        { success: false, message: "Only a student has a parent code." },
        { status: 403 },
      );
    }

    const code = await getOrCreateParentCode(payload.userId);
    if (!code) {
      return NextResponse.json({ success: false, message: "No student profile found." }, { status: 404 });
    }

    const parents = await db.parentStudent.findMany({
      where: { studentId: payload.userId },
      select: { parent: { select: { username: true, email: true } }, createdAt: true },
      orderBy: { createdAt: "asc" },
    });

    return NextResponse.json({
      success: true,
      code,
      username: payload.username,
      parents: parents.map((p) => ({
        username: p.parent.username,
        email: p.parent.email,
        linkedAt: p.createdAt,
      })),
    });
  } catch (error) {
    console.error("[user/parent-code] GET failed:", error);
    return NextResponse.json({ success: false, message: "Something went wrong." }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const payload = auth(request);
  if (!payload) return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });

  try {
    if (payload.role !== "STUDENT") {
      return NextResponse.json(
        { success: false, message: "Only a student has a parent code." },
        { status: 403 },
      );
    }

    const code = await regenerateParentCode(payload.userId);
    if (!code) {
      return NextResponse.json({ success: false, message: "No student profile found." }, { status: 404 });
    }

    // Worth logging: it invalidates a credential someone may already be holding.
    await writeAuditLog({
      action: "parentCode.regenerate",
      userId: payload.userId,
      metadata: {},
      request,
    });

    return NextResponse.json({ success: true, code });
  } catch (error) {
    console.error("[user/parent-code] POST failed:", error);
    return NextResponse.json({ success: false, message: "Something went wrong." }, { status: 500 });
  }
}
