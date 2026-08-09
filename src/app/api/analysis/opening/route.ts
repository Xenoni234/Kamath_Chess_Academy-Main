import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { verifyAccessToken } from "@/lib/auth";
import { openingQuerySchema } from "@/lib/validations/phase2";

export const runtime = "nodejs";

const DEFAULT_SPEEDS = ["blitz", "rapid", "classical"];
const DEFAULT_RATINGS = ["1600", "1800", "2000", "2200", "2500"];
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

// The explorer moved off explorer.lichess.ovh and now requires an OAuth token
// (see the `security: OAuth2` block in the Lichess OpenAPI spec for
// /lichess). Any Lichess personal access token works — no scopes needed.
const EXPLORER_BASE = "https://explorer.lichess.org/lichess";

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

  const { fen } = parsed.data;
  const speeds = parsed.data.speeds ?? DEFAULT_SPEEDS;
  const ratings = parsed.data.ratings ?? DEFAULT_RATINGS;

  // Filters change the response, so they belong in the cache key.
  const fenHash = crypto
    .createHash("md5")
    .update(`${fen}|${speeds.join(",")}|${ratings.join(",")}`)
    .digest("hex");

  try {
    const cached = await db.openingCache.findUnique({ where: { fenHash } });
    if (cached && cached.expiresAt > new Date()) {
      return NextResponse.json({ success: true, explorer: cached.data, cached: true });
    }

    const url = `${EXPLORER_BASE}?fen=${encodeURIComponent(
      fen,
    )}&speeds=${speeds.join(",")}&ratings=${ratings.join(",")}&topGames=0&recentGames=0`;

    const lichessToken = process.env.LICHESS_API_TOKEN;
    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
        ...(lichessToken ? { Authorization: `Bearer ${lichessToken}` } : {}),
      },
    });

    if (response.status === 401 || response.status === 403) {
      console.error("Opening explorer rejected the request — check LICHESS_API_TOKEN.");
      return NextResponse.json(
        { success: false, message: "Opening explorer is not configured." },
        { status: 502 },
      );
    }

    if (response.status === 429) {
      return NextResponse.json(
        { success: false, message: "Opening explorer is busy — try again shortly." },
        { status: 429 },
      );
    }

    if (!response.ok) {
      return NextResponse.json(
        { success: false, message: "Opening explorer fetch failed" },
        { status: 502 },
      );
    }

    const data = await response.json();
    const expiresAt = new Date(Date.now() + CACHE_TTL_MS);

    await db.openingCache.upsert({
      where: { fenHash },
      create: { fenHash, data, expiresAt },
      update: { data, expiresAt },
    });

    return NextResponse.json({ success: true, explorer: data, cached: false });
  } catch (error) {
    console.error("Opening explorer request failed:", error);
    return NextResponse.json(
      { success: false, message: "Opening explorer fetch failed" },
      { status: 502 },
    );
  }
}
