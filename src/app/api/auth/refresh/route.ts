import { NextRequest, NextResponse } from "next/server";
import { signAccessToken, verifyRefreshToken } from "@/lib/auth";
import { db } from "@/lib/db";
import { clientIp } from "@/lib/http/clientIp";
import { consume } from "@/lib/http/rateLimit";
import { tooManyRequests } from "@/lib/http/tooMany";

/**
 * Mints a fresh access token from the refresh cookie.
 *
 * Every signed-in user hits this every 15 minutes, so it is the single most
 * damaging place to conflate "your token is bad" with "the server had a
 * problem": one database blip used to answer 401 "Invalid refresh token", and
 * the client tears the session down on that. A lookup failure is now a 500, so
 * the client retries instead of logging the user out.
 *
 * Metered because it was completely unbounded: a database lookup per request, reachable
 * without an access token. The cap is generous for exactly the reason above — a whole school
 * behind one address, each student refreshing every 15 minutes, must never hit it. 60 per five
 * minutes is roughly six times the busiest realistic case.
 */
const MAX_PER_IP = 60;
const IP_WINDOW_MS = 5 * 60_000;

export async function POST(request: NextRequest) {
  const limited = consume(`refresh:ip:${clientIp(request)}`, MAX_PER_IP, IP_WINDOW_MS);
  if (limited.limited) {
    return tooManyRequests(limited.retryAfterSeconds);
  }

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
