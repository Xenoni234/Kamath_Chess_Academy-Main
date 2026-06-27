import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

export async function POST(request: NextRequest) {
  const refreshToken = request.cookies.get("kca_refresh_token")?.value;

  if (refreshToken) {
    await db.userSession.deleteMany({ where: { refreshToken } });
  }

  const response = NextResponse.json({ success: true });
  response.cookies.delete("kca_access_token");
  response.cookies.delete("kca_refresh_token");

  return response;
}
