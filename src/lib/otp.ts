import bcrypt from "bcryptjs";
import { db } from "./db";

const MAX_ATTEMPTS = 5;

export async function verifyOtpCode(params: {
  email: string;
  otp: string;
  purpose: "register" | "login";
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
