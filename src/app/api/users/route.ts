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

    /**
     * `?role=` takes one role or several, comma-separated.
     *
     * It was one only, and that quietly excluded HEAD from every "pick a coach" dropdown
     * — even though HEAD passes `requireRole(["HR","HEAD","COACH"])` on classes and batches
     * everywhere else, and at a small academy the owner is usually the one teaching. The
     * list you can assign from has to match the list the API will accept.
     *
     * Unknown names are dropped rather than failing the request: a stale caller asking for
     * a role that no longer exists should get a narrower list, not an error.
     */
    const roleParam = request.nextUrl.searchParams.get("role");
    const roles = (roleParam ?? "")
      .split(",")
      .map((r) => r.trim().toUpperCase())
      .filter((r) => VALID_ROLES.includes(r)) as Role[];
    const where = roles.length ? { role: { in: roles } } : {};

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
