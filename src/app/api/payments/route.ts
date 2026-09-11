import { NextRequest, NextResponse } from "next/server";
import { verifyAccessToken } from "@/lib/auth";
import { canViewStudent, requireRole } from "@/lib/authz";
import { db } from "@/lib/db";
import { createNotification } from "@/lib/notify";
import { writeAuditLog } from "@/lib/audit";
import { enqueueInvoice } from "@/lib/queue/queues";
import { paymentCreateSchema, paymentQuerySchema } from "@/lib/validations/admin";

export const runtime = "nodejs";

/**
 * Fees.
 *
 * These are OFFLINE records — cash, UPI or bank transfer entered by staff.
 * Razorpay stays disabled (`isPaymentsEnabled()` is false) during the free
 * testing period, so nothing here takes a card or talks to a gateway; it is a
 * ledger the academy keeps and parents can see.
 */

/** Staff see everything (optionally filtered); everyone else sees their own or
 *  their child's, via the shared `canViewStudent` rule. */
export async function GET(request: NextRequest) {
  const token = request.cookies.get("kca_access_token")?.value;
  if (!token) return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });

  let payload;
  try {
    payload = verifyAccessToken(token);
  } catch {
    return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
  }

  const parsed = paymentQuerySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!parsed.success) {
    return NextResponse.json({ success: false, message: "Invalid filters" }, { status: 400 });
  }
  const { userId, status, limit } = parsed.data;
  const isStaff = payload.role === "HR" || payload.role === "HEAD";

  if (userId && !(await canViewStudent(payload, userId))) {
    return NextResponse.json({ success: false, message: "Not found" }, { status: 404 });
  }
  if (!userId && !isStaff) {
    // Non-staff must name whose ledger they want, and pass the ownership check.
    return NextResponse.json({ success: false, message: "userId is required" }, { status: 400 });
  }

  const payments = await db.payment.findMany({
    where: { ...(userId ? { userId } : {}), ...(status ? { status } : {}) },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: {
      id: true,
      userId: true,
      amount: true,
      currency: true,
      status: true,
      method: true,
      description: true,
      note: true,
      dueDate: true,
      paidAt: true,
      createdAt: true,
      user: { select: { id: true, username: true, email: true } },
      invoice: { select: { id: true, number: true } },
    },
  });

  return NextResponse.json({
    success: true,
    payments: payments.map((p) => ({ ...p, amount: Number(p.amount) })),
  });
}

/** Record a payment or raise a due. Staff only. */
export async function POST(request: NextRequest) {
  const token = request.cookies.get("kca_access_token")?.value;
  if (!token) return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });

  let payload;
  try {
    payload = verifyAccessToken(token);
  } catch {
    return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
  }

  const denied = requireRole(payload, ["HR", "HEAD"]);
  if (denied) return denied;

  const body = await request.json().catch(() => null);
  const parsed = paymentCreateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, message: "Validation failed.", errors: parsed.error.flatten().fieldErrors },
      { status: 400 },
    );
  }

  const { userId, amount, status, method, description, note, dueDate } = parsed.data;

  const student = await db.user.findUnique({ where: { id: userId }, select: { id: true } });
  if (!student) return NextResponse.json({ success: false, message: "Student not found" }, { status: 404 });

  const payment = await db.payment.create({
    data: {
      userId,
      amount,
      status,
      method,
      description,
      note,
      dueDate,
      recordedById: payload.userId,
      paidAt: status === "COMPLETED" ? new Date() : null,
    },
    select: { id: true, amount: true, status: true, description: true, dueDate: true },
  });

  await writeAuditLog({
    action: "payment.record",
    userId: payload.userId,
    metadata: { paymentId: payment.id, studentId: userId, amount, status },
    request,
  });

  await createNotification({
    userId,
    type: "PAYMENT_DUE",
    title: status === "COMPLETED" ? "Payment recorded" : "Payment due",
    body:
      status === "COMPLETED"
        ? `We've recorded your payment of ₹${amount}${description ? ` for ${description}` : ""}.`
        : `A payment of ₹${amount}${description ? ` for ${description}` : ""} is due${dueDate ? ` by ${new Date(dueDate).toLocaleDateString("en-IN")}` : ""}.`,
  }).catch(() => {});

  // A payment recorded as already settled gets its invoice now. Enqueued rather
  // than awaited: rendering spawns a Chromium and would otherwise hold the staff
  // member's request open for seconds. runInvoiceJob is idempotent, so the
  // PENDING -> COMPLETED path in [id]/route.ts cannot double-issue.
  if (payment.status === "COMPLETED") {
    await enqueueInvoice({ paymentId: payment.id }).catch((error) =>
      console.error("[payments] could not enqueue invoice:", error),
    );
  }

  return NextResponse.json(
    { success: true, payment: { ...payment, amount: Number(payment.amount) } },
    { status: 201 },
  );
}
