import { NextRequest, NextResponse } from "next/server";
import type { Role } from "@prisma/client";
import { verifyAccessToken } from "@/lib/auth";
import { requireRole } from "@/lib/authz";
import { db } from "@/lib/db";

const VALID_ROLES = ["STUDENT", "PARENT", "COACH", "HR", "HEAD"];

/** HR/HEAD directory lookup — pick coaches/students when scheduling & enrolling. */
export async function GET(request: NextRequest) {
  const token = request.cookies.get("kca_access_token")?.value;
  if (!token) {
    return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
  }

  try {
    const payload = verifyAccessToken(token);
    const denied = requireRole(payload, ["HR", "HEAD"]);
    if (denied) return denied;

    const roleParam = request.nextUrl.searchParams.get("role");
    const where = roleParam && VALID_ROLES.includes(roleParam) ? { role: roleParam as Role } : {};

    const users = await db.user.findMany({
      where: { ...where, isActive: true },
      select: { id: true, username: true, role: true },
      orderBy: { username: "asc" },
      take: 500,
    });

    return NextResponse.json({ success: true, users });
  } catch {
    return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
  }
}
