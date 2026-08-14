import { addDays } from "date-fns";
import { NextRequest, NextResponse } from "next/server";
import { comparePassword, signAccessToken, signRefreshToken } from "@/lib/auth";
import { db } from "@/lib/db";
import { loginSchema } from "@/lib/validations";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const result = loginSchema.safeParse(body);

    if (!result.success) {
      return NextResponse.json(
        { success: false, message: "Validation failed.", errors: result.error.flatten().fieldErrors },
        { status: 400 }
      );
    }

    const { identifier, password } = result.data;
    const user = await db.user.findFirst({
      where: {
        OR: [{ email: identifier.toLowerCase() }, { username: identifier }],
        isActive: true,
      },
      // Only these fields are used below; without a select the whole row crosses
      // the wire on every login attempt.
      select: { id: true, username: true, email: true, role: true, passwordHash: true },
    });

    if (!user || !(await comparePassword(password, user.passwordHash))) {
      return NextResponse.json({ success: false, message: "Invalid credentials." }, { status: 401 });
    }

    const tokenPayload = { userId: user.id, username: user.username, role: user.role };
    const accessToken = signAccessToken(tokenPayload);
    const refreshToken = signRefreshToken(tokenPayload);
    const expiresAt = addDays(new Date(), 7);

    const userAgent = request.headers.get("user-agent");
    const ipAddress = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();

    // Independent writes — running them one after the other cost two full round
    // trips to Tokyo instead of one.
    await Promise.all([
      db.userSession.create({
        data: { userId: user.id, refreshToken, expiresAt, userAgent, ipAddress },
      }),
      db.auditLog.create({
        data: { userId: user.id, action: "USER_LOGGED_IN", userAgent, ipAddress },
      }),
    ]);

    const response = NextResponse.json({
      success: true,
      user: { id: user.id, username: user.username, email: user.email, role: user.role },
    });

    response.cookies.set("kca_access_token", accessToken, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 60 * 15,
    });
    response.cookies.set("kca_refresh_token", refreshToken, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 60 * 60 * 24 * 7,
    });

    return response;
  } catch (error) {
    console.error("Login failed:", error);
    return NextResponse.json({ success: false, message: "Login failed." }, { status: 500 });
  }
}
