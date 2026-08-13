import { NextRequest, NextResponse } from "next/server";
import { verifyAccessToken } from "@/lib/auth";
import { db } from "@/lib/db";

export async function GET(request: NextRequest) {
  const token = request.cookies.get("kca_access_token")?.value;
  if (!token) {
    return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
  }

  try {
    const payload = verifyAccessToken(token);
    const [notifications, unread] = await Promise.all([
      db.notification.findMany({
        where: { userId: payload.userId },
        orderBy: { createdAt: "desc" },
        take: 30,
      }),
      db.notification.count({ where: { userId: payload.userId, readAt: null } }),
    ]);
    return NextResponse.json({ success: true, notifications, unread });
  } catch {
    return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
  }
}
