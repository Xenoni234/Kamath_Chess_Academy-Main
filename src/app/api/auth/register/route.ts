import { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { hashPassword } from "@/lib/auth";
import { verifyOtpCode } from "@/lib/otp";
import { registerSchema, CODE_REQUIRED_ROLES } from "@/lib/validations";
import { consumeInviteCode, peekInviteCode } from "@/lib/inviteCodes";
import { resolveParentClaim } from "@/lib/parentCode";

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
    // The form offers four roles. Two are granted on the spot; COACH and HR
    // additionally need a single-use code the academy head issued beforehand.
    //
    // Read from `data`, never the raw body: the point of the schema is that a
    // hand-written request cannot widen this.
    const role = data.role;
    const needsCode = (CODE_REQUIRED_ROLES as readonly string[]).includes(role);
    const isParent = role === "PARENT";

    // A profile row only makes sense for a student. A parent gets theirs when
    // staff link them to a child; a coach gets one on approval.
    const profile = role === "STUDENT" ? { studentProfile: { create: {} } } : {};

    // Validate the code BEFORE creating anything, so a bad code does not leave a
    // half-made account behind. It is consumed after the user exists, because the
    // consumption records who used it.
    if (needsCode) {
      const supplied = (data.inviteCode ?? "").trim();
      if (!supplied) {
        return NextResponse.json(
          {
            success: false,
            message: "That role needs an invite code from the academy.",
            errors: { inviteCode: ["An invite code is required for this role."] },
          },
          { status: 400 },
        );
      }
      const check = await peekInviteCode({ code: supplied, role });
      if (!check.ok) {
        return NextResponse.json(
          { success: false, message: check.reason, errors: { inviteCode: [check.reason] } },
          { status: 400 },
        );
      }
    }

    // A parent account exists to read one child's attendance, reports and fees,
    // so it may not be created without proving which child — and that the family
    // shared the claim. The student's username alone is guessable; the code alone
    // says nothing about whose it is. Both, together, is the proof.
    let parentOf: string | null = null;
    if (isParent) {
      const claim = await resolveParentClaim({
        studentUsername: data.studentUsername ?? "",
        parentCode: data.parentCode ?? "",
      });
      if (!claim.ok) {
        return NextResponse.json(
          { success: false, message: claim.reason, errors: { parentCode: [claim.reason] } },
          { status: 400 },
        );
      }
      parentOf = claim.studentId;
    }

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
        ...profile,

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
              viaInviteCode: needsCode,
            },
          },
        },
      },
      select: { id: true, username: true, email: true, role: true },
    });

    // Link the parent to the child they proved a claim to. Without this the
    // account is a PARENT with no children — a blank dashboard and no way to fix
    // it without staff intervention, which defeats the whole point of the code.
    if (parentOf) {
      await db.parentStudent.create({ data: { parentId: user.id, studentId: parentOf } }).catch((error) => {
        console.error("[register] parent link failed:", error);
      });
    }

    // Burn the code now that there is an account to attribute it to. The claim is
    // atomic, so a second person racing the same code loses here rather than both
    // walking away with a staff account.
    if (needsCode) {
      const claimed = await consumeInviteCode({
        code: (data.inviteCode ?? "").trim(),
        role,
        userId: user.id,
      });
      if (!claimed.ok) {
        // Lost the race between the check above and this claim. Undo the account
        // rather than leave an unearned coach behind.
        await db.user.delete({ where: { id: user.id } }).catch(() => {});
        return NextResponse.json(
          { success: false, message: claimed.reason, errors: { inviteCode: [claimed.reason] } },
          { status: 400 },
        );
      }
    }

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
