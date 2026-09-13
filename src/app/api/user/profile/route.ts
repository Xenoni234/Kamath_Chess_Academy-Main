import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { verifyAccessToken, hashPassword, comparePassword } from "@/lib/auth";
import { db } from "@/lib/db";
import { writeAuditLog } from "@/lib/audit";

export const runtime = "nodejs";

/**
 * A person's own profile: read it, change their details, change their password.
 *
 * Strictly self-scoped. There is no `userId` parameter anywhere in this file — the
 * identity comes from the verified cookie and nothing else, so no amount of crafted input
 * can make it edit somebody else's account. Staff editing other people is a different
 * route (`/api/admin/users`) with its own role checks.
 *
 * **Email is deliberately read-only here.** It is the address the account recovers
 * through, so changing it without proving control of the new one is an account-takeover
 * path: set it to an address you own, trigger a password reset, and the account is yours.
 * Doing it properly means an OTP to the new address before the change applies. Until that
 * exists, the page tells the student to ask the academy, and staff can do it through the
 * admin route. Do not "simplify" this by adding email to the update schema.
 */

const profileSchema = z.object({
  username: z.string().trim().min(3).max(24).regex(/^[a-zA-Z0-9_]+$/, "Letters, numbers and _ only").optional(),
  mobile: z.string().trim().regex(/^[0-9]{10,15}$/, "Digits only, 10-15 of them").optional(),
  bio: z.string().trim().max(280).optional().or(z.literal("")),
  lichessId: z.string().trim().max(40).optional().or(z.literal("")),
  chesscomId: z.string().trim().max(40).optional().or(z.literal("")),
  fideId: z.string().trim().regex(/^[0-9]{0,20}$/, "Digits only").optional().or(z.literal("")),
});

const passwordSchema = z.object({
  currentPassword: z.string().min(1, "Enter your current password"),
  // Matches registration. A weaker rule here would be a back door around it.
  newPassword: z
    .string()
    .min(8, "At least 8 characters")
    .regex(/[a-z]/, "Needs a lowercase letter")
    .regex(/[A-Z]/, "Needs an uppercase letter")
    .regex(/[0-9]/, "Needs a number"),
});

const bodySchema = z.union([
  z.object({ action: z.literal("profile") }).and(profileSchema),
  z.object({ action: z.literal("password") }).and(passwordSchema),
]);

function authed(request: NextRequest) {
  const token = request.cookies.get("kca_access_token")?.value;
  if (!token) return null;
  try {
    return verifyAccessToken(token);
  } catch {
    return null;
  }
}

export async function GET(request: NextRequest) {
  const payload = authed(request);
  if (!payload) {
    return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
  }

  // Authentication is its own small try above; a failure below is a server fault and
  // must not masquerade as an expired session.
  try {
    const user = await db.user.findUnique({
      where: { id: payload.userId },
      select: {
        username: true,
        email: true,
        mobile: true,
        role: true,
        bio: true,
        lichessId: true,
        chesscomId: true,
        fideId: true,
        isVerified: true,
        createdAt: true,
      },
    });
    if (!user) {
      return NextResponse.json({ success: false, message: "Not found" }, { status: 404 });
    }
    return NextResponse.json({ success: true, profile: user });
  } catch (error) {
    console.error("[user/profile] GET failed:", error);
    return NextResponse.json({ success: false, message: "Something went wrong." }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  const payload = authed(request);
  if (!payload) {
    return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, message: "Invalid request" }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    const errors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const field = String(issue.path[0] ?? "form");
      errors[field] ??= issue.message;
    }
    return NextResponse.json({ success: false, message: "Please check the form", errors }, { status: 400 });
  }

  try {
    if (parsed.data.action === "password") {
      const user = await db.user.findUnique({
        where: { id: payload.userId },
        select: { passwordHash: true },
      });
      if (!user) {
        return NextResponse.json({ success: false, message: "Not found" }, { status: 404 });
      }

      // The current password is required even though the session is already valid: it is
      // what stops a borrowed or unattended browser being turned into a permanent
      // takeover, which is the whole reason this check exists on every site that has it.
      const ok = await comparePassword(parsed.data.currentPassword, user.passwordHash);
      if (!ok) {
        return NextResponse.json(
          { success: false, message: "That is not your current password", errors: { currentPassword: "Incorrect password" } },
          { status: 400 },
        );
      }

      await db.user.update({
        where: { id: payload.userId },
        data: { passwordHash: await hashPassword(parsed.data.newPassword) },
      });
      await writeAuditLog({ action: "user.password.change", userId: payload.userId, request });
      return NextResponse.json({ success: true, message: "Password changed" });
    }

    const { action: _action, ...fields } = parsed.data;
    void _action;

    // Empty strings mean "clear this", which for a unique nullable column has to become
    // NULL — several empty strings would collide on the unique index and the second
    // student to clear their Lichess handle would be told it was taken.
    const data: Prisma.UserUpdateInput = {};
    if (fields.username !== undefined) data.username = fields.username;
    if (fields.mobile !== undefined) data.mobile = fields.mobile;
    if (fields.bio !== undefined) data.bio = fields.bio === "" ? null : fields.bio;
    if (fields.lichessId !== undefined) data.lichessId = fields.lichessId === "" ? null : fields.lichessId;
    if (fields.chesscomId !== undefined) data.chesscomId = fields.chesscomId === "" ? null : fields.chesscomId;
    if (fields.fideId !== undefined) data.fideId = fields.fideId === "" ? null : fields.fideId;

    if (Object.keys(data).length === 0) {
      return NextResponse.json({ success: true, message: "Nothing to change" });
    }

    try {
      await db.user.update({ where: { id: payload.userId }, data });
    } catch (error) {
      // P2002 is the unique constraint. Naming the field turns "something went wrong"
      // into "that username is taken", which is the difference between a form a child can
      // fix and one they give up on.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        const target = (error.meta?.target as string[] | undefined)?.[0] ?? "field";
        const label: Record<string, string> = {
          username: "That username is already taken",
          mobile: "That mobile number is already registered",
          lichessId: "That Lichess account is already linked to someone else",
          chesscomId: "That Chess.com account is already linked to someone else",
          fideId: "That FIDE ID is already linked to someone else",
        };
        return NextResponse.json(
          { success: false, message: label[target] ?? "Already in use", errors: { [target]: label[target] ?? "Already in use" } },
          { status: 409 },
        );
      }
      throw error;
    }

    await writeAuditLog({
      action: "user.profile.update",
      userId: payload.userId,
      metadata: { fields: Object.keys(data) },
      request,
    });
    return NextResponse.json({ success: true, message: "Saved" });
  } catch (error) {
    console.error("[user/profile] PATCH failed:", error);
    return NextResponse.json({ success: false, message: "Something went wrong." }, { status: 500 });
  }
}
