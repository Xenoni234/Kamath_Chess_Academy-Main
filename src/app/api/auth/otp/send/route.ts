import bcrypt from "bcryptjs";
import { Resend } from "resend";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";

type OtpPurpose = "register" | "login";

function isPurpose(value: unknown): value is OtpPurpose {
  return value === "register" || value === "login";
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const email = typeof body.email === "string" ? body.email.toLowerCase() : "";
    const purpose = body.purpose;

    if (!email || !isPurpose(purpose)) {
      return NextResponse.json({ success: false, error: "Invalid request" }, { status: 400 });
    }

    const since = new Date(Date.now() - 60 * 60 * 1000);
    const requestsLastHour = await db.otpVerification.count({
      where: {
        email,
        purpose,
        createdAt: { gte: since },
      },
    });

    if (requestsLastHour >= 3) {
      return NextResponse.json({ success: false, error: "Too many OTP requests" }, { status: 429 });
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const hashedOtp = await bcrypt.hash(otp, 10);

    await db.otpVerification.create({
      data: {
        email,
        otpHash: hashedOtp,
        purpose,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
        attempts: 0,
      },
    });

    const emailFrom = process.env.EMAIL_FROM;
    if (!emailFrom) {
      return NextResponse.json({ success: false, error: "Email sender is not configured" }, { status: 500 });
    }

    const resend = new Resend(process.env.RESEND_API_KEY);
    await resend.emails.send({
      from: emailFrom,
      to: email,
      subject: "Your KCA verification code",
      html: `<p>Your KCA OTP is: <strong>${otp}</strong></p>
           <p>Valid for 10 minutes. Do not share this code.</p>`,
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("OTP send failed:", error);
    return NextResponse.json({ success: false, error: "Failed to send OTP" }, { status: 500 });
  }
}
