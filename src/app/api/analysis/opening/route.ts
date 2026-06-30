import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { verifyAccessToken } from "@/lib/auth";

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

  const fen = request.nextUrl.searchParams.get("fen");

  if (!fen) {
    return NextResponse.json({ success: false, message: "Missing fen" }, { status: 400 });
  }

  const fenHash = crypto.createHash("md5").update(fen).digest("hex");
  const cached = await db.openingCache.findUnique({ where: { fenHash } });

  if (cached && cached.expiresAt > new Date()) {
    return NextResponse.json(cached.data);
  }

  const url = `https://explorer.lichess.ovh/lichess?fen=${encodeURIComponent(
    fen,
  )}&speeds=blitz,rapid,classical&ratings=1600,1800,2000,2200,2500&topGames=0`;
  const response = await fetch(url);

  if (!response.ok) {
    return NextResponse.json({ success: false, message: "Opening explorer fetch failed" }, { status: 502 });
  }

  const data = await response.json();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

  await db.openingCache.upsert({
    where: { fenHash },
    create: { fenHash, data, expiresAt },
    update: { data, expiresAt },
  });

  return NextResponse.json(data);
}
