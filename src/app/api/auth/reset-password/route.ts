import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { hashPassword } from "@/lib/auth";
import { verifyOtpCode } from "@/lib/otp";
import { writeAuditLog } from "@/lib/audit";
import { resetPasswordSchema } from "@/lib/validations/phase2";

export const runtime = "nodejs";

/**
 * Set a new password using an emailed code.
 *
 * The code is verified and consumed here in the same call that sets the password —
 * there is deliberately no standalone "verify" step, because consuming the row in
 * one request and then needing it in the next is how that endpoint became a trap.
 *
 * Also the activation path for staff-created accounts: they are created without a
 * usable password and the invite email points here.
 */
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null);
    const parsed = resetPasswordSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { success: false, message: "Validation failed.", errors: parsed.error.flatten().fieldErrors },
        { status: 400 },
      );
    }

    const { email, otp, password } = parsed.data;

    const otpResult = await verifyOtpCode({ email, otp, purpose: "reset" });
    if (!otpResult.success) {
      return NextResponse.json({ success: false, message: otpResult.error }, { status: 400 });
    }

    const user = await db.user.findUnique({ where: { email }, select: { id: true } });
    if (!user) {
      // The code was valid, so this can only happen if the account vanished
      // between request and reset. Say nothing specific.
      return NextResponse.json({ success: false, message: "Could not reset the password." }, { status: 400 });
    }

    const passwordHash = await hashPassword(password);
    await db.user.update({
      where: { id: user.id },
      // A reset proves control of the mailbox, so it also verifies the account —
      // this is what activates a staff-created invite.
      data: { passwordHash, isVerified: true },
    });

    // Every existing session is now stale: a password reset must log other
    // devices out, otherwise a compromised session survives the recovery.
    await db.userSession.deleteMany({ where: { userId: user.id } }).catch(() => {});

    await writeAuditLog({ action: "auth.password.reset", userId: user.id, request });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("[auth] password reset failed:", error);
    return NextResponse.json({ success: false, message: "Could not reset the password." }, { status: 500 });
  }
}
