import { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { hashPassword } from "@/lib/auth";
import { verifyOtpCode } from "@/lib/otp";
import { registerSchema } from "@/lib/validations";

/**
 * Bumped whenever the wording of the terms, privacy policy or consent checkboxes
 * changes materially. Stored per user so we can tell who agreed to which version,
 * and so a future re-consent prompt knows who still needs asking.
 */
const CONSENT_VERSION = "2026-09";

export async function POST(request: Request) {
  try {
    const body = await request.json();

    const result = registerSchema.safeParse(body);

    if (!result.success) {
      return NextResponse.json(
        { success: false, message: "Validation failed.", errors: result.error.flatten().fieldErrors },
        { status: 400 }
      );
    }

    const data = result.data;
    // One canonical form of the address everywhere: the OTP row, the lookup and
    // the stored user. These disagreed before, so a capitalised address could be
    // sent a code it could never redeem.
    const email = data.email.toLowerCase();

    // No bypass. The `NODE_ENV === "development" && otp === "000000"` shortcut that
    // used to live here was the only reason registration appeared to work — nothing
    // in the app requested a real code, so production sign-up returned 400 every time.
    const otpResult = await verifyOtpCode({ email, otp: data.otp, purpose: "register" });

    if (!otpResult.success) {
      return NextResponse.json({ success: false, message: otpResult.error }, { status: 400 });
    }

    const passwordHash = await hashPassword(data.password);
    const role = "STUDENT";

    // One timestamp for every consent granted in this request.

    const now = new Date();

    const user = await db.user.create({
      data: {
        username: data.username,
        email,
        mobile: data.mobile,
        passwordHash,
        role,
        isVerified: otpResult.success,
        isActive: true,
        fideId: data.fideId || null,
        lichessId: data.lichessId || null,
        chesscomId: data.chesscomId || null,
        studentProfile: { create: {} },

        // DPDPA consent, recorded as timestamps on the account.
        //
        // These used to exist only inside the audit-log JSON below, and the three
        // MANDATORY consents were validated by the schema and then discarded
        // entirely — so the academy held no queryable proof of consent for a
        // minor's data. `registerSchema` refines that all three are true before
        // we get here, so stamping "now" is accurate.
        consentVersion: CONSENT_VERSION,
        consentTermsAt: now,
        consentAgeAt: now,
        consentDataProcessingAt: now,
        consentMarketing: data.agreedToMarketing,
        consentMarketingAt: data.agreedToMarketing ? now : null,
        consentSms: data.agreedToSms,
        consentSmsAt: data.agreedToSms ? now : null,

        // Kept alongside the columns: it preserves the historical record format
        // that scripts/backfillConsent.ts reads for pre-existing accounts.
        auditLogs: {
          create: {
            action: "USER_REGISTERED",
            metadata: {
              marketingEmailConsent: data.agreedToMarketing,
              smsNotificationConsent: data.agreedToSms,
              consentVersion: CONSENT_VERSION,
            },
          },
        },
      },
      select: { id: true, username: true, email: true, role: true },
    });

    return NextResponse.json({ success: true, user }, { status: 201 });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const haystack = (error.message + JSON.stringify(error.meta ?? "")).toLowerCase();

      // Map the conflicting column onto a per-field message so the register
      // page renders it under the offending input, not just as a banner.
      const conflict: { field: string; message: string } = haystack.includes("email")
        ? { field: "email", message: "An account with this email already exists." }
        : haystack.includes("username")
          ? { field: "username", message: "This username is already taken." }
          : haystack.includes("mobile")
            ? { field: "mobile", message: "This mobile number is already registered." }
            : { field: "form", message: "An account with those details already exists." };

      return NextResponse.json(
        { success: false, message: conflict.message, errors: { [conflict.field]: [conflict.message] } },
        { status: 409 }
      );
    }

    // Log the real error server-side only; never leak Prisma internals or a
    // stack trace to the client.
    console.error("Registration failed:", error);
    return NextResponse.json({ success: false, message: "Registration failed. Please try again." }, { status: 500 });
  }
}
