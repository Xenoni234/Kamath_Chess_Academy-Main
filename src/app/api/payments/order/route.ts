/**
 * Open a Razorpay order against a payment the academy has already recorded.
 *
 * Deliberately NOT "create an order for an arbitrary amount". The client sends a
 * `paymentId`, and the order is opened for exactly that row's amount. A student
 * cannot name their own price, and there is no path where an attacker settles a
 * ₹5,000 due with a ₹1 order.
 *
 * The order id is stored on `Payment.providerRef` so the webhook can find the row
 * again. `@@unique([provider, providerRef])` then makes a duplicate settlement
 * impossible at the database level rather than only in application logic.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { verifyAccessToken } from "@/lib/auth";
import { canViewStudent } from "@/lib/authz";
import { db } from "@/lib/db";
import { writeAuditLog } from "@/lib/audit";
import { isPaymentsEnabled, razorpayClient, toPaise, publishableKeyId } from "@/lib/razorpay";

export const runtime = "nodejs";

const orderSchema = z.object({ paymentId: z.string().min(1) });

export async function POST(request: NextRequest) {
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

  try {
    if (!isPaymentsEnabled()) {
      return NextResponse.json(
        { success: false, message: "Online payments are not enabled yet." },
        { status: 503 },
      );
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ success: false, message: "Invalid request body" }, { status: 400 });
    }

    const parsed = orderSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, message: "Validation failed.", errors: parsed.error.flatten().fieldErrors },
        { status: 400 },
      );
    }

    const payment = await db.payment.findUnique({
      where: { id: parsed.data.paymentId },
      select: {
        id: true,
        userId: true,
        amount: true,
        currency: true,
        status: true,
        description: true,
        provider: true,
        providerRef: true,
      },
    });

    // 404, not 403 — a payment id must not be confirmable by a stranger.
    if (!payment) {
      return NextResponse.json({ success: false, message: "Not found" }, { status: 404 });
    }
    if (!(await canViewStudent(payload, payment.userId))) {
      return NextResponse.json({ success: false, message: "Not found" }, { status: 404 });
    }
    if (payment.status !== "PENDING") {
      return NextResponse.json(
        { success: false, message: "That payment is not awaiting settlement." },
        { status: 409 },
      );
    }

    // Reuse an order already opened for this row rather than stacking orders.
    if (payment.providerRef) {
      return NextResponse.json({
        success: true,
        orderId: payment.providerRef,
        amount: toPaise(Number(payment.amount)),
        currency: payment.currency,
        keyId: publishableKeyId(),
        reused: true,
      });
    }

    const client = await razorpayClient();
    const order = await client.orders.create({
      amount: toPaise(Number(payment.amount)),
      currency: payment.currency,
      receipt: payment.id,
      notes: { paymentId: payment.id, description: payment.description ?? "Academy fees" },
    });

    await db.payment.update({
      where: { id: payment.id },
      data: { provider: "razorpay", providerRef: order.id },
    });

    await writeAuditLog({
      action: "payment.order.create",
      userId: payload.userId,
      metadata: { paymentId: payment.id, orderId: order.id, amount: Number(payment.amount) },
      request,
    });

    return NextResponse.json({
      success: true,
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      keyId: publishableKeyId(),
      reused: false,
    });
  } catch (error) {
    console.error("[payments/order] POST failed:", error);
    return NextResponse.json({ success: false, message: "Something went wrong." }, { status: 500 });
  }
}
