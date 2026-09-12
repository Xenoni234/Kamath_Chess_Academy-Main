import fs from "node:fs/promises";
import { NextRequest, NextResponse } from "next/server";
import { verifyAccessToken } from "@/lib/auth";
import { db } from "@/lib/db";
import { errorPage } from "@/lib/http/errorPage";

export const runtime = "nodejs";

/**
 * Serves an opening guide's PDF, inline for reading or as a download.
 * Global — any signed-in user may read it, because a repertoire is identical for everyone.
 *
 * The PDF lives on the row now. It used to live only in /tmp, which is wiped on every
 * redeploy, so this route answered
 * `{"success":false,"message":"This repertoire's file has expired — regenerate it …"}`
 * as raw JSON, in a browser tab, to a child — the same defect already fixed for game
 * reports and dossiers. The link is a plain `<a href>`, so every failure here is reached
 * by NAVIGATION and must answer with a readable page, never JSON.
 */
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const token = request.cookies.get("kca_access_token")?.value;

  if (!token) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  try {
    verifyAccessToken(token);
  } catch {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  // A failure below here is a server fault, not an auth failure. Returning 401
  // for it used to log every user out on a single database blip, silently.
  try {
    const { id } = await context.params;

    const repertoire = await db.openingRepertoire.findUnique({
      where: { id },
      select: { name: true, status: true, pdf: true, pdfUrl: true },
    });

    if (!repertoire) {
      return errorPage({
        title: "We couldn't find that opening",
        body: "It may have been renamed or removed. Try searching for it again.",
        status: 404,
        backHref: "/dashboard/opening",
        backLabel: "Back to openings",
      });
    }

    if (repertoire.status !== "complete") {
      return errorPage({
        title: "This guide isn't ready yet",
        body: "Your coach's computer is still working out the best lines. Try again in a few minutes.",
        status: 404,
        backHref: `/dashboard/opening/${id}`,
        backLabel: "Back to the opening",
      });
    }

    let pdf: Buffer | null = repertoire.pdf ? Buffer.from(repertoire.pdf) : null;

    // Guides built before the PDF was stored on the row kept only a /tmp path. Read it if
    // it somehow survived, so older guides are not needlessly lost.
    if (!pdf && repertoire.pdfUrl) {
      try {
        pdf = await fs.readFile(repertoire.pdfUrl);
      } catch {
        pdf = null;
      }
    }

    if (!pdf) {
      return errorPage({
        title: "This guide is too old to open",
        body: "It was made before we started keeping guides safely. Build it again and it will stay.",
        status: 404,
        backHref: `/dashboard/opening/${id}`,
        backLabel: "Back to the opening",
      });
    }

    // `?view=1` opens it in the browser; anything else downloads it.
    const inline = request.nextUrl.searchParams.get("view") === "1";
    const safeName =
      repertoire.name.replace(/[^a-zA-Z0-9_-]/g, "-").replace(/-+/g, "-").slice(0, 60) || "opening";

    return new NextResponse(new Uint8Array(pdf), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="kca-opening-${safeName}.pdf"`,
        "Cache-Control": "private, no-store",
      },
    });
  } catch (error) {
    console.error("[opening/[id]/download] GET failed:", error);
    return errorPage({
      title: "Something went wrong",
      body: "That is our fault, not yours. Please try again in a moment.",
      status: 500,
      backHref: `/dashboard/opening`,
      backLabel: "Back to openings",
    });
  }
}
