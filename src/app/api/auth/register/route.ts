import { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { hashPassword } from "@/lib/auth";
import { verifyOtpCode } from "@/lib/otp";
import { registerSchema } from "@/lib/validations";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    console.log('=== REGISTER BODY RECEIVED ===', JSON.stringify(body, null, 2));

    const result = registerSchema.safeParse(body);

    if (!result.success) {
      return NextResponse.json(
        { success: false, message: "Validation failed.", errors: result.error.flatten().fieldErrors },
        { status: 400 }
      );
    }

    const data = result.data;

    if (!(process.env.NODE_ENV === "development" && data.otp === "000000")) {
      const otpResult = await verifyOtpCode({
        email: data.email,
        otp: data.otp,
        purpose: "register",
      });

      if (!otpResult.success) {
        return NextResponse.json({ success: false, message: otpResult.error }, { status: 400 });
      }
    }

    const passwordHash = await hashPassword(data.password);
    const role = "STUDENT";

    const user = await db.user.create({
      data: {
        username: data.username,
        email: data.email.toLowerCase(),
        mobile: data.mobile,
        passwordHash,
        role,
        isVerified: true,
        isActive: true,
        fideId: data.fideId || null,
        lichessId: data.lichessId || null,
        chesscomId: data.chesscomId || null,
        studentProfile: { create: {} },
        auditLogs: {
          create: {
            action: "USER_REGISTERED",
            metadata: {
              marketingEmailConsent: data.agreedToMarketing,
              smsNotificationConsent: data.agreedToSms,
            },
          },
        },
      },
      select: { id: true, username: true, email: true, role: true },
    });

    return NextResponse.json({ success: true, user }, { status: 201 });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const errMsg = error.message.toLowerCase();
      const metaStr = JSON.stringify(error.meta || "").toLowerCase();
      
      if (errMsg.includes("email") || metaStr.includes("email")) {
        return NextResponse.json(
          { success: false, message: "An account with this email already exists." },
          { status: 409 }
        );
      }
      if (errMsg.includes("username") || metaStr.includes("username")) {
        return NextResponse.json(
          { success: false, message: "This username is already taken." },
          { status: 409 }
        );
      }
      if (errMsg.includes("mobile") || metaStr.includes("mobile")) {
        return NextResponse.json(
          { success: false, message: "This mobile number is already registered." },
          { status: 409 }
        );
      }
      return NextResponse.json(
        { success: false, message: "An account with those details already exists." },
        { status: 409 }
      );
    }

    console.error("Registration failed:", error);
    return NextResponse.json({ success: false, message: "Registration failed.", error: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined }, { status: 500 });
  }
}
