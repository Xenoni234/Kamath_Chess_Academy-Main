import bcrypt from "bcryptjs";
import { db } from "./db";

const MAX_ATTEMPTS = 5;

export async function verifyOtpCode(params: {
  email: string;
  otp: string;
  purpose: "register" | "login" | "reset";
}) {
  const verification = await db.otpVerification.findFirst({
    where: {
      email: params.email.toLowerCase(),
      purpose: params.purpose,
      expiresAt: { gt: new Date() },
    },
    orderBy: { createdAt: "desc" },
  });

  if (!verification) {
    return { success: false, error: "Invalid OTP" };
  }

  if (verification.attempts >= MAX_ATTEMPTS) {
    await db.otpVerification.delete({ where: { id: verification.id } });
    return { success: false, error: "Too many OTP attempts" };
  }

  await db.otpVerification.update({
    where: { id: verification.id },
    data: { attempts: { increment: 1 } },
  });

  const matches = await bcrypt.compare(params.otp, verification.otpHash);

  if (!matches) {
    return { success: false, error: "Invalid OTP" };
  }

  await db.otpVerification.delete({ where: { id: verification.id } });
  return { success: true, verified: true };
}

// ---------------------------------------------------------------------------

const TTL_MS = 10 * 60 * 1000;

const SUBJECTS: Record<string, string> = {
  register: "Your Kamath Chess Academy verification code",
  reset: "Reset your Kamath Chess Academy password",
  login: "Your Kamath Chess Academy sign-in code",
  invite: "Your Kamath Chess Academy account is ready",
};

/**
 * Create a one-time code and email it.
 *
 * Shared by the public send endpoint and by staff account creation, so an invited
 * coach or parent activates through exactly the same verified path a self-service
 * user does — no second, weaker password channel, and no password ever emailed.
 */
export async function issueOtpCode(params: {
  email: string;
  purpose: "register" | "login" | "reset";
  /** Extra line above the code, e.g. "An account has been created for you." */
  intro?: string;
}): Promise<{ success: boolean; error?: string }> {
  const { default: bcryptLib } = await import("bcryptjs");
  const crypto = await import("node:crypto");
  const { Resend } = await import("resend");

  const email = params.email.toLowerCase();
  // crypto.randomInt, not Math.random — this code gates account access.
  const otp = String(crypto.randomInt(100000, 1000000));
  const otpHash = await bcryptLib.hash(otp, 10);

  await db.otpVerification.create({
    data: {
      email,
      otpHash,
      purpose: params.purpose,
      expiresAt: new Date(Date.now() + TTL_MS),
      attempts: 0,
    },
  });

  const emailFrom = process.env.EMAIL_FROM;
  if (!emailFrom) {
    console.error("[otp] EMAIL_FROM is not configured");
    return { success: false, error: "Email sending is not configured." };
  }

  const resend = new Resend(process.env.RESEND_API_KEY);
  await resend.emails.send({
    from: emailFrom,
    to: email,
    subject: SUBJECTS[params.purpose] ?? SUBJECTS.register,
    html: `<div style="font-family:system-ui,-apple-system,Segoe UI,Helvetica,Arial,sans-serif;max-width:480px">
  <h2 style="margin:0 0 8px">Kamath Chess Academy</h2>
  ${params.intro ? `<p style="margin:0 0 12px;color:#444">${params.intro}</p>` : ""}
  <p style="margin:0 0 16px;color:#444">Your verification code is:</p>
  <p style="font-size:32px;letter-spacing:8px;font-weight:700;margin:0 0 16px">${otp}</p>
  <p style="margin:0;color:#666;font-size:13px">Valid for 10 minutes. If you did not expect this, ignore this email — and never share the code with anyone.</p>
</div>`,
  });

  return { success: true };
}
