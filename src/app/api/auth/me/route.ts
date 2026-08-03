import { NextRequest, NextResponse } from "next/server";
import { verifyAccessToken } from "@/lib/auth";

export const runtime = "nodejs";

// Debug/utility endpoint: reports which account the current cookie belongs to.
// Useful for confirming which user a given browser window is actually signed in
// as, independent of any page's rendered state.
export async function GET(request: NextRequest) {
  const token = request.cookies.get("kca_access_token")?.value;

  if (!token) {
    return NextResponse.json({ success: false, message: "Not signed in (no cookie)." }, { status: 401 });
  }

  try {
    const payload = verifyAccessToken(token);
    return NextResponse.json({
      success: true,
      user: { userId: payload.userId, username: payload.username, role: payload.role },
    });
  } catch {
    return NextResponse.json({ success: false, message: "Invalid or expired session." }, { status: 401 });
  }
}
