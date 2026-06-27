import { NextRequest, NextResponse } from "next/server";
import { signAccessToken, verifyRefreshToken } from "@/lib/auth";
import { db } from "@/lib/db";

export async function POST(request: NextRequest) {
  try {
    const refreshToken = request.cookies.get("kca_refresh_token")?.value;

    if (!refreshToken) {
      return NextResponse.json({ success: false, message: "Missing refresh token." }, { status: 401 });
    }

    const session = await db.userSession.findUnique({ where: { refreshToken } });

    if (!session || session.expiresAt < new Date()) {
      return NextResponse.json({ success: false, message: "Invalid refresh token." }, { status: 401 });
    }

    const payload = verifyRefreshToken(refreshToken);
    const accessToken = signAccessToken({
      userId: payload.userId,
      username: payload.username,
      role: payload.role,
    });

    const response = NextResponse.json({ success: true });
    response.cookies.set("kca_access_token", accessToken, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 60 * 15,
    });

    return response;
  } catch {
    return NextResponse.json({ success: false, message: "Invalid refresh token." }, { status: 401 });
  }
}
