import fs from "node:fs/promises";
import { NextRequest, NextResponse } from "next/server";
import { verifyAccessToken } from "@/lib/auth";
import { db } from "@/lib/db";
import { errorPage } from "@/lib/http/errorPage";

export const runtime = "nodejs";

/**
 * Streams a dossier's PDF. Owner-only.
 *
 * Like the game-report download, the file lives in /tmp — ephemeral and
 * per-instance — so a 404 for an older dossier is expected rather than an error.
 */
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
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
    const { id } = await context.params;

    const profile = await db.opponentProfile.findUnique({
      where: { id },
      select: {
        requestedById: true,
        handle: true,
        repertoires: {
          orderBy: { createdAt: "desc" },
          take: 1,
          select: { pdf: true, pdfUrl: true },
        },
      },
    });

    const back = { backHref: "/dashboard/second", backLabel: "Back to my dossiers" };

    if (!profile || profile.requestedById !== payload.userId) {
      return errorPage({
        title: "We couldn't find that dossier",
        body: "It may belong to someone else, or it may have been deleted.",
        status: 404,
        ...back,
      });
    }

    const plan = profile.repertoires[0];

    if (!plan) {
      return errorPage({
        title: "This dossier isn't ready yet",
        body: "We're still going through their games. Try again in a few minutes.",
        status: 404,
        ...back,
      });
    }

    let pdf: Buffer | null = plan.pdf ? Buffer.from(plan.pdf) : null;

    // Dossiers built before the PDF was stored on the row kept only a /tmp path. Read it
    // if it somehow survived, so an older dossier is not needlessly lost.
    if (!pdf && plan.pdfUrl) {
      try {
        pdf = await fs.readFile(plan.pdfUrl);
      } catch {
        pdf = null;
      }
    }

    if (!pdf) {
      return errorPage({
        title: "This dossier is too old to open",
        body: "It was made before we started keeping dossiers safely. Use Regenerate and the new one will stay in your account.",
        status: 404,
        ...back,
      });
    }

    const safeHandle = profile.handle.replace(/[^a-zA-Z0-9_-]/g, "") || "opponent";
    const inline = request.nextUrl.searchParams.get("view") === "1";

    return new NextResponse(new Uint8Array(pdf), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="kca-dossier-${safeHandle}.pdf"`,
        "Cache-Control": "private, no-store",
      },
    });
  } catch (error) {
    console.error("[second/profiles/[id]/download] GET failed:", error);
    return NextResponse.json({ success: false, message: "Something went wrong." }, { status: 500 });
  }
}
