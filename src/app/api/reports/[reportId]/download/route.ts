import fs from "node:fs/promises";
import { NextRequest, NextResponse } from "next/server";
import { verifyAccessToken } from "@/lib/auth";
import { db } from "@/lib/db";
import { errorPage } from "@/lib/http/errorPage";

export const runtime = "nodejs";

/**
 * Serves a finished report's PDF, inline for reading or as a download.
 *
 * The PDF lives on the report row now. It used to be written to /tmp and emailed, with
 * the email as "the durable copy" — so after any redeploy this route answered
 * `{"success":false,"message":"This report's file has expired — check your email …"}`,
 * as raw JSON, in a browser tab, to a nine-year-old. Reports are no longer emailed and no
 * longer expire; they stay in the student's account.
 *
 * Failures here are reached by NAVIGATION, not by fetch(), so they answer with a readable
 * page (`errorPage`) rather than JSON.
 */
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ reportId: string }> },
) {
  const token = request.cookies.get("kca_access_token")?.value;

  if (!token) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  let payload: ReturnType<typeof verifyAccessToken>;
  try {
    payload = verifyAccessToken(token);
  } catch {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  // A failure below here is a server fault, not an auth failure. Returning 401
  // for it used to log every user out on a single database blip, silently.
  try {
    const { reportId } = await context.params;

    const report = await db.gameReport.findUnique({
      where: { id: reportId },
      select: { userId: true, status: true, pdf: true, pdfUrl: true, createdAt: true },
    });

    // Same treatment for "not yours" and "not found" so the route cannot be
    // used to probe which report ids exist.
    if (!report || report.userId !== payload.userId) {
      return errorPage({
        title: "We couldn't find that report",
        body: "It may belong to someone else, or it may have been deleted.",
        status: 404,
        backHref: "/dashboard/reports",
        backLabel: "Back to my reports",
      });
    }

    if (report.status !== "complete") {
      return errorPage({
        title: "This report isn't ready yet",
        body: "Your coach's computer is still looking at your games. Try again in a few minutes.",
        status: 404,
        backHref: "/dashboard/reports",
        backLabel: "Back to my reports",
      });
    }

    let pdf: Buffer | null = report.pdf ? Buffer.from(report.pdf) : null;

    // Reports made before the PDF was stored on the row kept only a /tmp path. Read it if
    // it is somehow still there, so old reports are not needlessly lost.
    if (!pdf && report.pdfUrl) {
      try {
        pdf = await fs.readFile(report.pdfUrl);
      } catch {
        pdf = null;
      }
    }

    if (!pdf) {
      return errorPage({
        title: "This report is too old to open",
        body: "It was made before we started keeping reports safely. Make a new one and it will stay in your account.",
        status: 404,
        backHref: "/dashboard/reports",
        backLabel: "Back to my reports",
      });
    }

    // `?view=1` opens it in the browser; anything else downloads it.
    const inline = request.nextUrl.searchParams.get("view") === "1";
    const stamp = report.createdAt.toISOString().slice(0, 10);

    return new NextResponse(new Uint8Array(pdf), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="kca-report-${stamp}.pdf"`,
        "Cache-Control": "private, no-store",
      },
    });
  } catch (error) {
    console.error("[reports/[reportId]/download] GET failed:", error);
    return errorPage({
        title: "Something went wrong",
        body: "That is our fault, not yours. Please try again in a moment.",
        status: 500,
        backHref: "/dashboard/reports",
        backLabel: "Back to my reports",
      });
  }
}
