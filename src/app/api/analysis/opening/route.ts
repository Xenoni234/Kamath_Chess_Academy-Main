import { NextRequest, NextResponse } from "next/server";
import { verifyAccessToken } from "@/lib/auth";
import { openingQuerySchema } from "@/lib/validations/phase2";
import { fetchExplorer } from "@/lib/second/explorer";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const token = request.cookies.get("kca_access_token")?.value;
  if (!token) {
    return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
  }
  try {
    verifyAccessToken(token);
  } catch {
    return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
  }

  const parsed = openingQuerySchema.safeParse({
    fen: request.nextUrl.searchParams.get("fen") ?? undefined,
    speeds: request.nextUrl.searchParams.get("speeds") ?? undefined,
    ratings: request.nextUrl.searchParams.get("ratings") ?? undefined,
  });

  if (!parsed.success) {
    return NextResponse.json(
      { success: false, message: "Invalid request payload" },
      { status: 400 },
    );
  }

  try {
    const result = await fetchExplorer(parsed.data.fen, parsed.data.speeds, parsed.data.ratings);

    if (result.ok) {
      return NextResponse.json({ success: true, explorer: result.data, cached: result.cached });
    }

    if (result.status === 401 || result.status === 403) {
      console.error("Opening explorer rejected the request — check LICHESS_API_TOKEN.");
      return NextResponse.json(
        { success: false, message: "Opening explorer is not configured." },
        { status: 502 },
      );
    }

    if (result.status === 429) {
      return NextResponse.json(
        { success: false, message: "Opening explorer is busy — try again shortly." },
        { status: 429 },
      );
    }

    return NextResponse.json(
      { success: false, message: "Opening explorer fetch failed" },
      { status: 502 },
    );
  } catch (error) {
    console.error("Opening explorer request failed:", error);
    return NextResponse.json(
      { success: false, message: "Opening explorer fetch failed" },
      { status: 502 },
    );
  }
}
