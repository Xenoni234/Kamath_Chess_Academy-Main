import crypto from "node:crypto";
import { Prisma } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";
import { verifyAccessToken, hashPassword } from "@/lib/auth";
import { requireRole } from "@/lib/authz";
import { db } from "@/lib/db";
import { issueOtpCode } from "@/lib/otp";
import { writeAuditLog } from "@/lib/audit";
import { createUserSchema, userQuerySchema, HR_CREATABLE_ROLES } from "@/lib/validations/admin";

export const runtime = "nodejs";

/** List accounts. Staff only. */
export async function GET(request: NextRequest) {
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

  const parsed = userQuerySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!parsed.success) {
    return NextResponse.json({ success: false, message: "Invalid filters" }, { status: 400 });
  }
  const { role, q, limit } = parsed.data;

  const users = await db.user.findMany({
    where: {
      ...(role ? { role } : {}),
      ...(q
        ? {
            OR: [
              { username: { contains: q, mode: "insensitive" as const } },
              { email: { contains: q, mode: "insensitive" as const } },
            ],
          }
        : {}),
    },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: {
      id: true,
      username: true,
      email: true,
      mobile: true,
      role: true,
      isActive: true,
      isVerified: true,
      createdAt: true,
      parentLinks: { select: { student: { select: { id: true, username: true } } } },
    },
  });

  return NextResponse.json({ success: true, users });
}

/**
 * Create an account with a role.
 *
 * No password is set or emailed: the account gets an unusable random hash and the
 * person activates it with a one-time code through the normal reset flow. That
 * keeps a single, verified way to own a password.
 */
export async function POST(request: NextRequest) {
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

  const body = await request.json().catch(() => null);
  const parsed = createUserSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, message: "Validation failed.", errors: parsed.error.flatten().fieldErrors },
      { status: 400 },
    );
  }

  const { username, email, mobile, role, childIds } = parsed.data;

  // HR runs day-to-day admissions; minting staff is the HEAD's call. Without this
  // an HR account could promote itself by creating a second HEAD.
  if (payload.role === "HR" && !HR_CREATABLE_ROLES.includes(role as (typeof HR_CREATABLE_ROLES)[number])) {
    return NextResponse.json(
      { success: false, message: "Only the academy head can create staff accounts." },
      { status: 403 },
    );
  }

  // Unguessable and never disclosed — the invite code is the only way in.
  const placeholderHash = await hashPassword(crypto.randomBytes(32).toString("hex"));

  try {
    const user = await db.user.create({
      data: {
        username,
        email,
        mobile,
        role,
        passwordHash: placeholderHash,
        isVerified: false,
        isActive: true,
        ...(role === "STUDENT" ? { studentProfile: { create: {} } } : {}),
        ...(role === "COACH" ? { coachProfile: { create: {} } } : {}),
        ...(childIds?.length
          ? { parentLinks: { create: childIds.map((studentId) => ({ studentId })) } }
          : {}),
      },
      select: { id: true, username: true, email: true, role: true, isActive: true, isVerified: true },
    });

    await writeAuditLog({
      action: "admin.user.create",
      userId: payload.userId,
      metadata: { createdUserId: user.id, role, byRole: payload.role },
      request,
    });

    // Best-effort: the account exists either way, and an invite can be resent.
    const invited = await issueOtpCode({
      email,
      purpose: "reset",
      intro: `An account has been created for you at Kamath Chess Academy (${role.toLowerCase()}). Use this code on the "Set your password" page to finish setting up.`,
    }).catch((error) => {
      console.error("[admin] invite email failed:", error);
      return { success: false as const };
    });

    return NextResponse.json({ success: true, user, invited: invited.success }, { status: 201 });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const target = String(error.meta?.target ?? "").toLowerCase();
      const field = target.includes("email") ? "email" : target.includes("mobile") ? "mobile" : "username";
      return NextResponse.json(
        { success: false, message: `That ${field} is already registered.`, errors: { [field]: ["Already in use"] } },
        { status: 409 },
      );
    }
    console.error("[admin] user creation failed:", error);
    return NextResponse.json({ success: false, message: "Could not create the account." }, { status: 500 });
  }
}
