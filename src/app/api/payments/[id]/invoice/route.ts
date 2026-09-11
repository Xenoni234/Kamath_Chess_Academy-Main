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
 */
import fs from "node:fs/promises";
import { NextRequest, NextResponse } from "next/server";
import { verifyAccessToken } from "@/lib/auth";
import { canViewMoney } from "@/lib/authz";
import { db } from "@/lib/db";
import { writeAuditLog } from "@/lib/audit";

export const runtime = "nodejs";

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

    const payment = await db.payment.findUnique({
      where: { id },
      select: { userId: true, invoice: { select: { id: true, number: true, pdfUrl: true } } },
    });

    if (!payment || !payment.invoice) {
      return NextResponse.json({ success: false, message: "Not found" }, { status: 404 });
    }
    if (!(await canViewMoney(payload, payment.userId))) {
      return NextResponse.json({ success: false, message: "Not found" }, { status: 404 });
    }
    if (!payment.invoice.pdfUrl) {
      return NextResponse.json({ success: false, message: "Invoice is not ready" }, { status: 404 });
    }

    let pdf: Buffer;
    try {
      pdf = await fs.readFile(payment.invoice.pdfUrl);
    } catch {
      return NextResponse.json(
        {
          success: false,
          message: "This invoice's file has expired — check your email for the copy we sent.",
        },
        { status: 404 },
      );
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

    return new NextResponse(new Uint8Array(pdf), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${safeNumber}.pdf"`,
        "Cache-Control": "private, no-store",
      },
    });
  } catch (error) {
    console.error("[payments/[id]/invoice] GET failed:", error);
    return NextResponse.json({ success: false, message: "Something went wrong." }, { status: 500 });
  }
}
