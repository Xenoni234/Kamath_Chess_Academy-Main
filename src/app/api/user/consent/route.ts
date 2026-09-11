/**
 * Read and update your own consent preferences.
 *
 * Self-scoped only — there is no `userId` parameter and no role gate, because
 * consent is personal and nobody may grant or withdraw it on another account's
 * behalf through this route. Staff who need to act on a request use the contact
 * inbox and the anonymisation path instead.
 *
 * `consentVersion: null` means the account predates consent being recorded on the
 * User row. The client must render that as UNKNOWN, never as refused — the user
 * did tick the boxes, we simply didn't keep the record until now.
 */
import { NextRequest, NextResponse } from "next/server";
import { verifyAccessToken } from "@/lib/auth";
import { db } from "@/lib/db";
import { writeAuditLog } from "@/lib/audit";
import { consentUpdateSchema } from "@/lib/validations/compliance";

export const runtime = "nodejs";

const SELECT = {
  consentVersion: true,
  consentTermsAt: true,
  consentAgeAt: true,
  consentDataProcessingAt: true,
  consentMarketing: true,
  consentMarketingAt: true,
  consentSms: true,
  consentSmsAt: true,
} as const;

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

  try {
    const user = await db.user.findUnique({ where: { id: payload.userId }, select: SELECT });
    if (!user) {
      return NextResponse.json({ success: false, message: "Not found" }, { status: 404 });
    }
    return NextResponse.json({
      success: true,
      consent: {
        ...user,
        // Explicit rather than implied by a null date, so no client has to guess.
        recorded: user.consentVersion !== null,
      },
    });
  } catch (error) {
    console.error("[user/consent] GET failed:", error);
    return NextResponse.json({ success: false, message: "Something went wrong." }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
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

  try {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ success: false, message: "Invalid request body" }, { status: 400 });
    }

    const parsed = consentUpdateSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, message: "Validation failed.", errors: parsed.error.flatten().fieldErrors },
        { status: 400 },
      );
    }

    const before = await db.user.findUnique({ where: { id: payload.userId }, select: SELECT });
    if (!before) {
      return NextResponse.json({ success: false, message: "Not found" }, { status: 404 });
    }

    const now = new Date();
    const { marketing, sms } = parsed.data;
    const user = await db.user.update({
      where: { id: payload.userId },
      data: {
        ...(marketing !== undefined ? { consentMarketing: marketing, consentMarketingAt: now } : {}),
        ...(sms !== undefined ? { consentSms: sms, consentSmsAt: now } : {}),
      },
      select: SELECT,
    });

    // Withdrawal is the half that matters legally — log both directions with the
    // before/after so there is a record of when it changed and to what.
    await writeAuditLog({
      action: "consent.update",
      userId: payload.userId,
      metadata: {
        from: { marketing: before.consentMarketing, sms: before.consentSms },
        to: { marketing: user.consentMarketing, sms: user.consentSms },
      },
      request,
    });

    return NextResponse.json({ success: true, consent: { ...user, recorded: user.consentVersion !== null } });
  } catch (error) {
    console.error("[user/consent] PATCH failed:", error);
    return NextResponse.json({ success: false, message: "Something went wrong." }, { status: 500 });
  }
}
