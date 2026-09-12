import fs from "node:fs/promises";
import { NextRequest, NextResponse } from "next/server";
import { verifyAccessToken } from "@/lib/auth";
import { db } from "@/lib/db";

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
 * Every failure here is reached by NAVIGATION, not by fetch() — the reports page links
 * straight to this URL — so the response is a small HTML page rather than JSON. Written
 * for a young student: it says what happened and what to do, and nothing else.
 */
function page(title: string, body: string, status: number) {
  return new NextResponse(
    `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         background:#050505; color:#fff; font-family:system-ui,-apple-system,"Segoe UI",sans-serif;
         padding:24px; }
  .box { max-width:26rem; text-align:center; background:#0D0D0D; border:1px solid #1F1F1F;
         border-radius:16px; padding:40px 32px; }
  h1 { font-size:1.35rem; margin:0 0 12px; }
  p { color:#E0E0E0; line-height:1.6; margin:0 0 24px; font-size:1rem; }
  a { display:inline-block; background:#00C8E8; color:#050505; text-decoration:none;
      font-weight:700; padding:12px 24px; border-radius:10px; }
</style>
</head>
<body>
  <div class="box">
    <h1>${title}</h1>
    <p>${body}</p>
    <a href="/dashboard/reports">Back to my reports</a>
  </div>
</body>
</html>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "private, no-store" } },
  );
}

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
      return page("We couldn&rsquo;t find that report", "It may belong to someone else, or it may have been deleted.", 404);
    }

    if (report.status !== "complete") {
      return page(
        "This report isn&rsquo;t ready yet",
        "Your coach&rsquo;s computer is still looking at your games. Try again in a few minutes.",
        404,
      );
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
      return page(
        "This report is too old to open",
        "It was made before we started keeping reports safely. Make a new one and it will stay in your account.",
        404,
      );
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
    return page("Something went wrong", "That is our fault, not yours. Please try again in a moment.", 500);
  }
}
