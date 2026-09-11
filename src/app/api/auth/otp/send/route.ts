import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { issueOtpCode } from "@/lib/otp";
import { redis } from "@/lib/redis";
import { otpSendSchema } from "@/lib/validations/phase2";

export const runtime = "nodejs";

/** Per email+purpose, per rolling hour. */
const MAX_PER_EMAIL_HOUR = 3;
/**
 * Per client IP, per hour. The email limit alone is keyed on an attacker-supplied
 * value, so one client could walk a list of addresses and send each of them three
 * real emails — an email-bombing and Resend-quota vector.
 *
 * **Why this is 30 and not 10.** An IP is a poor proxy for a person here. Indian
 * mobile carriers run CGNAT, so a class of students "each on their own phone" can
 * still share one public address; so can everyone on the academy's WiFi. At 10 the
 * eleventh student is refused for something no one did wrong, and the failure
 * reads as "the site is broken" on the day it matters.
 *
 * The anti-harassment control is `MAX_PER_EMAIL_HOUR`, which is keyed to the
 * actual victim's address and stays at 3. This one only shapes bulk enumeration,
 * and 30/hour still makes walking a list of addresses slow and obvious.
 *
 * `OTP_MAX_PER_IP_HOUR` raises it further for a launch or a large intake session.
 */
const MAX_PER_IP_HOUR = Number(process.env.OTP_MAX_PER_IP_HOUR) || 30;

function clientIp(request: NextRequest): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return request.headers.get("x-real-ip") ?? "unknown";
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => null);
    const parsed = otpSendSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { success: false, message: parsed.error.issues[0].message },
        { status: 400 },
      );
    }

    // The schema lowercases; verifyOtpCode also looks up lowercased. These two
    // disagreed before, so any address typed with a capital letter (the default
    // on most phone keyboards) could receive a code and then never verify it.
    const { email, purpose } = parsed.data;

    const ipKey = `rate:otp:ip:${clientIp(request)}`;
    const ipCount = await redis.incr(ipKey);
    if (ipCount === 1) await redis.expire(ipKey, 60 * 60);
    if (ipCount > MAX_PER_IP_HOUR) {
      return NextResponse.json(
        { success: false, message: "Too many codes requested. Try again later." },
        { status: 429 },
      );
    }

    const since = new Date(Date.now() - 60 * 60 * 1000);
    const requestsLastHour = await db.otpVerification.count({
      where: { email, purpose, createdAt: { gte: since } },
    });

    if (requestsLastHour >= MAX_PER_EMAIL_HOUR) {
      return NextResponse.json(
        { success: false, message: "Too many codes requested for this address. Try again in an hour." },
        { status: 429 },
      );
    }

    // A password reset for an unknown address must look identical to a real one,
    // or this endpoint becomes an account-existence oracle.
    if (purpose === "reset") {
      const exists = await db.user.findUnique({ where: { email }, select: { id: true } });
      if (!exists) return NextResponse.json({ success: true });
    }

    const issued = await issueOtpCode({ email, purpose });
    if (!issued.success) {
      // Give the IP allowance back. The per-email limit is derived from stored
      // rows and `issueOtpCode` already deletes the unsendable one, so that side
      // corrects itself; this counter does not.
      //
      // It matters because the common causes of a failed send — an unverified
      // sending domain, a provider outage — are not the user's doing. Charging
      // them for it locks them out for an hour from retrying something that was
      // never going to work until someone else fixed it.
      await redis.decr(ipKey).catch(() => {});
      return NextResponse.json({ success: false, message: issued.error }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("[otp] send failed:", error);
    return NextResponse.json({ success: false, message: "Could not send the code." }, { status: 500 });
  }
}
