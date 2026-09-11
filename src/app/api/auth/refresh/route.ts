import { NextRequest, NextResponse } from "next/server";
import { signAccessToken, verifyRefreshToken } from "@/lib/auth";
import { db } from "@/lib/db";

/**
 * Mints a fresh access token from the refresh cookie.
 *
 * Every signed-in user hits this every 15 minutes, so it is the single most
 * damaging place to conflate "your token is bad" with "the server had a
 * problem": one database blip used to answer 401 "Invalid refresh token", and
 * the client tears the session down on that. A lookup failure is now a 500, so
 * the client retries instead of logging the user out.
 */
export async function POST(request: NextRequest) {
  const refreshToken = request.cookies.get("kca_refresh_token")?.value;

  if (!refreshToken) {
    return NextResponse.json({ success: false, message: "Missing refresh token." }, { status: 401 });
  }

  let session;
  try {
    session = await db.userSession.findUnique({ where: { refreshToken } });
  } catch (error) {
    console.error("[auth/refresh] session lookup failed:", error);
    return NextResponse.json({ success: false, message: "Something went wrong." }, { status: 500 });
  }

  if (!session || session.expiresAt < new Date()) {
    return NextResponse.json({ success: false, message: "Invalid refresh token." }, { status: 401 });
  }

  try {
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
