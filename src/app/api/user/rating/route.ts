import { NextRequest, NextResponse } from "next/server";
import { verifyAccessToken } from "@/lib/auth";
import { db } from "@/lib/db";
import type { TimeFormat } from "@prisma/client";

export async function GET(request: NextRequest) {
  const token = request.cookies.get("kca_access_token")?.value;

  if (!token) {
    return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
  }

  try {
    const payload = verifyAccessToken(token);
    const format = request.nextUrl.searchParams.get("format") as TimeFormat | null;

    if (!format || !["BULLET", "BLITZ", "RAPID", "CLASSICAL"].includes(format)) {
      return NextResponse.json(
        { success: false, message: "Missing or invalid format query parameter. Use BULLET, BLITZ, RAPID, or CLASSICAL." },
        { status: 400 }
      );
    }

    const rating = await db.rating.findUnique({
      where: {
        userId_format: {
          userId: payload.userId,
          format,
        },
      },
      select: {
        rating: true,
        rd: true,
      },
    });

    return NextResponse.json({
      success: true,
      rating: rating?.rating ?? 1500,
      rd: rating?.rd ?? 350,
    });
  } catch {
    return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
  }
}
