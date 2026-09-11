import { NextRequest, NextResponse } from "next/server";
import { verifyAccessToken } from "@/lib/auth";
import { requireRole } from "@/lib/authz";
import { db } from "@/lib/db";
import { writeAuditLog } from "@/lib/audit";
import { enqueueInvoice } from "@/lib/queue/queues";
import { paymentUpdateSchema } from "@/lib/validations/admin";

export const runtime = "nodejs";

/** Settle or correct a payment. Staff only. */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const token = request.cookies.get("kca_access_token")?.value;
  if (!token) return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });

  let payload;
  try {
    payload = verifyAccessToken(token);
  } catch {
    return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
  }

  const denied = requireRole(payload, ["HEAD"]);
  if (denied) return denied;

  const { id } = await params;
  const body = await request.json().catch(() => null);
  const parsed = paymentUpdateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ success: false, message: "Validation failed." }, { status: 400 });
  }

  const existing = await db.payment.findUnique({ where: { id }, select: { id: true, status: true } });
  if (!existing) return NextResponse.json({ success: false, message: "Not found" }, { status: 404 });

  const { status, method, note } = parsed.data;
  const payment = await db.payment.update({
    where: { id },
    data: {
      status,
      ...(method ? { method } : {}),
      ...(note !== undefined ? { note } : {}),
      paidAt: status === "COMPLETED" ? new Date() : null,
    },
    select: { id: true, amount: true, status: true, paidAt: true },
  });

  await writeAuditLog({
    action: "payment.update",
    userId: payload.userId,
    metadata: { paymentId: id, from: existing.status, to: status },
    request,
  });

  // Only the transition INTO completed issues an invoice. Re-PATCHing an already
  // COMPLETED payment must not mint a second one — runInvoiceJob would refuse
  // anyway, but not enqueuing is cheaper and states the intent.
  if (status === "COMPLETED" && existing.status !== "COMPLETED") {
    await enqueueInvoice({ paymentId: id }).catch((error) =>
      console.error("[payments] could not enqueue invoice:", error),
    );
  }

  return NextResponse.json({ success: true, payment: { ...payment, amount: Number(payment.amount) } });
}
