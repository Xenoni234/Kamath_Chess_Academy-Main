import { NextRequest, NextResponse } from "next/server";
import { verifyAccessToken } from "@/lib/auth";
import { db } from "@/lib/db";
import { ratingQuerySchema } from "@/lib/validations/phase2";

export async function GET(request: NextRequest) {
  const token = request.cookies.get("kca_access_token")?.value;

  if (!token) {
    return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
  }

  let payload: ReturnType<typeof verifyAccessToken>;
  try {
    payload = verifyAccessToken(token);
  } catch {
    return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
  }

  // A failure below here is a server fault, not an auth failure. Returning 401
  // for it used to log every user out on a single database blip, silently.
  try {
    const parsedFormat = ratingQuerySchema.safeParse({ format: request.nextUrl.searchParams.get("format") });
    if (!parsedFormat.success) {
      return NextResponse.json(
        { success: false, message: "Missing or invalid format query parameter. Use BULLET, BLITZ, RAPID, or CLASSICAL." },
        { status: 400 }
      );
    }
    const { format } = parsedFormat.data;

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
  } catch (error) {
    console.error("[user/rating] GET failed:", error);
    return NextResponse.json({ success: false, message: "Something went wrong." }, { status: 500 });
  }
}
