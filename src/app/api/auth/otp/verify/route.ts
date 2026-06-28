import { NextResponse } from "next/server";
import { verifyOtpCode } from "@/lib/otp";

type OtpPurpose = "register" | "login";

function isPurpose(value: unknown): value is OtpPurpose {
  return value === "register" || value === "login";
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const email = typeof body.email === "string" ? body.email.toLowerCase() : "";
    const otp = typeof body.otp === "string" ? body.otp : "";
    const purpose = body.purpose;

    if (!email || !otp || !isPurpose(purpose)) {
      return NextResponse.json({ success: false, error: "Invalid request" }, { status: 400 });
    }

    const result = await verifyOtpCode({ email, otp, purpose });
    return NextResponse.json(result, { status: result.success ? 200 : 400 });
  } catch (error) {
    console.error("OTP verify failed:", error);
    return NextResponse.json({ success: false, error: "OTP verification failed" }, { status: 500 });
  }
}
