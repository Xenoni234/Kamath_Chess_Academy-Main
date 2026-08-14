import { NextRequest, NextResponse } from "next/server";
import { verifyAccessToken } from "@/lib/auth";
import { db } from "@/lib/db";

export const runtime = "nodejs";

/** One dossier with its artifact and latest repertoire. Owner-only. */
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const token = request.cookies.get("kca_access_token")?.value;
  if (!token) {
    return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
  }
  try {
    const payload = verifyAccessToken(token);
    const { id } = await context.params;

    // Explicit select: `updatedAt` and the repertoire's `profileId`/`createdAt`
    // are never rendered, and `linesJson` is large enough that pulling whole
    // rows across a cross-region link is worth avoiding.
    const profile = await db.opponentProfile.findUnique({
      where: { id },
      select: {
        id: true,
        requestedById: true,
        handle: true,
        source: true,
        colorToPlay: true,
        fideId: true,
        status: true,
        gamesAnalyzed: true,
        ratingSummary: true,
        artifact: true,
        summary: true,
        createdAt: true,
        repertoires: {
          orderBy: { createdAt: "desc" },
          take: 1,
          select: { id: true, summary: true, linesJson: true, pdfUrl: true },
        },
      },
    });

    // "Not yours" and "not found" answer identically so the route cannot be
    // used to probe which profile ids exist.
    if (!profile || profile.requestedById !== payload.userId) {
      return NextResponse.json({ success: false, message: "Not found" }, { status: 404 });
    }

    const plan = profile.repertoires[0] ?? null;

    return NextResponse.json({
      success: true,
      profile: {
        id: profile.id,
        handle: profile.handle,
        source: profile.source,
        colorToPlay: profile.colorToPlay,
        fideId: profile.fideId,
        status: profile.status,
        gamesAnalyzed: profile.gamesAnalyzed,
        ratingSummary: profile.ratingSummary,
        artifact: profile.artifact,
        summary: profile.summary,
        createdAt: profile.createdAt,
        repertoire: plan
          ? { id: plan.id, summary: plan.summary, lines: plan.linesJson, hasPdf: Boolean(plan.pdfUrl) }
          : null,
      },
    });
  } catch {
    return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
  }
}
