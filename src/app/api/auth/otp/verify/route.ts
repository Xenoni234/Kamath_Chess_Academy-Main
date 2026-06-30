import { NextResponse } from "next/server";
import { verifyOtpCode } from "@/lib/otp";
import { otpVerifySchema } from "@/lib/validations/phase2";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const parsed = otpVerifySchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: parsed.error.issues[0].message },
        { status: 400 }
      );
    }

    const { email, otp, purpose } = parsed.data;

    const result = await verifyOtpCode({ email, otp, purpose });
    return NextResponse.json(result, { status: result.success ? 200 : 400 });
  } catch (error) {
    console.error("OTP verify failed:", error);
    return NextResponse.json({ success: false, error: "OTP verification failed" }, { status: 500 });
  }
}
