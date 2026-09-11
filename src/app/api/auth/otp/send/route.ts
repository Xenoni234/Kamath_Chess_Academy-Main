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
 */
const MAX_PER_IP_HOUR = 10;

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
      return NextResponse.json({ success: false, message: issued.error }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("[otp] send failed:", error);
    return NextResponse.json({ success: false, message: "Could not send the code." }, { status: 500 });
  }
}
