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

  let payload: ReturnType<typeof verifyAccessToken>;
  try {
    payload = verifyAccessToken(token);
  } catch {
    return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
  }

  // A failure below here is a server fault, not an auth failure. Returning 401
  // for it used to log every user out on a single database blip, silently.
  try {
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
  } catch (error) {
    console.error("[users] GET failed:", error);
    return NextResponse.json({ success: false, message: "Something went wrong." }, { status: 500 });
  }
}
