/**
 * Stream a payment's invoice PDF.
 *
 * Access differs deliberately from the report and dossier download routes. Those
 * are strictly `userId === payload.userId`, because a report belongs to the person
 * who asked for it. An invoice is about a *student*, and the people who legitimately
 * need it are the student, their parent, their coach, and academy staff — exactly
 * the set `canViewStudent` encodes. So ownership goes through that helper rather
 * than an identity comparison.
 *
 * 404, never 403, for "exists but not yours" — same as every other scoped route
 * here, so payment ids cannot be probed.
 *
 * The link is a plain `<a href>` in the fees tables, so every failure here is reached by
 * NAVIGATION: it answers with a readable page (`errorPage`), never JSON. The PDF itself
 * now lives on the Invoice row rather than only in /tmp, which is wiped on every redeploy
 * — a financial record must not depend on a file that disappears.
 */
import fs from "node:fs/promises";
import { NextRequest, NextResponse } from "next/server";
import { verifyAccessToken } from "@/lib/auth";
import { canViewMoney } from "@/lib/authz";
import { db } from "@/lib/db";
import { writeAuditLog } from "@/lib/audit";
import { errorPage } from "@/lib/http/errorPage";

export const runtime = "nodejs";

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
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
    const { id } = await context.params;

    const payment = await db.payment.findUnique({
      where: { id },
      select: {
        userId: true,
        invoice: { select: { id: true, number: true, pdf: true, pdfUrl: true } },
      },
    });

    // Same page for "no such payment" and "not yours", so ids cannot be probed.
    if (!payment || !payment.invoice || !(await canViewMoney(payload, payment.userId))) {
      return errorPage({
        title: "We couldn't find that invoice",
        body: "It may belong to someone else, or it may not have been issued yet.",
        status: 404,
        backHref: "/dashboard/fees",
        backLabel: "Back to fees",
      });
    }

    let pdf: Buffer | null = payment.invoice.pdf ? Buffer.from(payment.invoice.pdf) : null;

    // Invoices issued before the PDF was stored on the row kept only a /tmp path.
    if (!pdf && payment.invoice.pdfUrl) {
      try {
        pdf = await fs.readFile(payment.invoice.pdfUrl);
      } catch {
        pdf = null;
      }
    }

    if (!pdf) {
      return errorPage({
        title: "This invoice isn't ready yet",
        body: "We are still preparing it. Please try again in a few minutes, or contact the academy.",
        status: 404,
        backHref: "/dashboard/fees",
        backLabel: "Back to fees",
      });
    }

    if (payload.userId !== payment.userId) {
      await writeAuditLog({
        action: "invoice.download",
        userId: payload.userId,
        metadata: { paymentId: id, studentId: payment.userId, viewerRole: payload.role },
        request,
      });
    }

    const safeNumber = payment.invoice.number.replace(/[^a-zA-Z0-9_-]/g, "") || "invoice";
    // `?view=1` opens it in the browser; anything else downloads it.
    const inline = request.nextUrl.searchParams.get("view") === "1";

    return new NextResponse(new Uint8Array(pdf), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${safeNumber}.pdf"`,
        "Cache-Control": "private, no-store",
      },
    });
  } catch (error) {
    console.error("[payments/[id]/invoice] GET failed:", error);
    return errorPage({
      title: "Something went wrong",
      body: "That is our fault, not yours. Please try again in a moment.",
      status: 500,
      backHref: "/dashboard/fees",
      backLabel: "Back to fees",
    });
  }
}
