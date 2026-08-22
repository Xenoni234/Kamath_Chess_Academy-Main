import { NextRequest, NextResponse } from "next/server";
import { verifyAccessToken } from "@/lib/auth";
import { searchOpenings } from "@/lib/opening/eco";
import { resolveOpeningSchema } from "@/lib/validations/phase5";

export const runtime = "nodejs";

/** Autocomplete / disambiguation: ranked opening-name matches for a query. */
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

  const parsed = resolveOpeningSchema.safeParse({ q: request.nextUrl.searchParams.get("q") ?? "" });
  if (!parsed.success) {
    return NextResponse.json({ success: false, message: "Invalid query" }, { status: 400 });
  }

  const candidates = searchOpenings(parsed.data.q, 8).map((c) => ({
    name: c.name,
    eco: c.eco,
    moves: c.san,
  }));
  return NextResponse.json({ success: true, candidates });
}
