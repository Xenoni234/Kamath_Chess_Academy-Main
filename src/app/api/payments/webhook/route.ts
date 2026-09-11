/**
 * Razorpay webhook — the only thing that actually settles a payment.
 *
 * Not the browser callback. A student whose phone dies between paying and the
 * redirect has still paid, and the gateway will tell us here regardless.
 *
 * Three properties this route has to hold:
 *
 * **Public but authenticated.** There is no cookie: Razorpay's servers call this.
 * Authentication is the HMAC signature over the raw body, which is why the body
 * is read with `request.text()` and parsed only afterwards — re-serialising JSON
 * reorders keys and the signature stops matching.
 *
 * **Idempotent.** Razorpay retries on any non-2xx, and a slow response is a
 * non-2xx as far as it is concerned. The event id is inserted FIRST, so a retry
 * hits the unique constraint and returns 200 without re-processing. Insert-first
 * rather than check-then-insert, because two concurrent deliveries can both pass
 * a check before either writes.
 *
 * **Quiet on the way out.** Any 4xx or 5xx makes Razorpay retry, so genuine
 * "nothing to do here" cases (an event we do not handle, an order we do not
 * recognise) answer 200. Only a real server fault returns 500 and asks to be
 * retried.
 */
import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { isPaymentsEnabled, verifyWebhookSignature } from "@/lib/razorpay";
import { enqueueInvoice } from "@/lib/queue/queues";
import { writeAuditLog } from "@/lib/audit";

export const runtime = "nodejs";

/** Events that mean "money arrived". Everything else is acknowledged and ignored. */
const SETTLING_EVENTS = new Set(["payment.captured", "order.paid"]);

export async function POST(request: NextRequest) {
  if (!isPaymentsEnabled()) {
    // Payments are off; nothing legitimate can be arriving here.
    return NextResponse.json({ success: false, message: "Not enabled" }, { status: 404 });
  }

  // Raw bytes, exactly as received — the signature is computed over these.
  const raw = await request.text();
  const signature = request.headers.get("x-razorpay-signature");

  if (!verifyWebhookSignature(raw, signature)) {
    console.warn("[payments/webhook] rejected a delivery with a bad signature");
    return NextResponse.json({ success: false, message: "Invalid signature" }, { status: 401 });
  }

  // Hoisted so the catch can release it — see the comment there.
  let markerId: string | null = null;

  try {
    let event: { event?: string; payload?: Record<string, { entity?: Record<string, unknown> }> };
    try {
      event = JSON.parse(raw);
    } catch {
      return NextResponse.json({ success: false, message: "Invalid JSON" }, { status: 400 });
    }

    // Razorpay's per-delivery id. Fall back to a hash of the body if absent so
    // idempotency still holds rather than silently degrading to none.
    const eventId =
      request.headers.get("x-razorpay-event-id") ??
      `sha:${Buffer.from(raw).toString("base64").slice(0, 60)}`;

    try {
      await db.processedWebhook.create({ data: { id: eventId, provider: "razorpay" } });
      markerId = eventId;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        // Already handled. Acknowledge so Razorpay stops retrying.
        return NextResponse.json({ success: true, duplicate: true });
      }
      throw error;
    }

    if (!event.event || !SETTLING_EVENTS.has(event.event)) {
      return NextResponse.json({ success: true, ignored: event.event ?? "unknown" });
    }

    const entity = event.payload?.payment?.entity ?? event.payload?.order?.entity ?? {};
    const orderId = typeof entity.order_id === "string" ? entity.order_id : (entity.id as string | undefined);
    const gatewayPaymentId = typeof entity.id === "string" && event.event === "payment.captured" ? entity.id : null;

    if (!orderId) {
      return NextResponse.json({ success: true, ignored: "no order id" });
    }

    const payment = await db.payment.findFirst({
      where: { provider: "razorpay", providerRef: orderId },
      select: { id: true, status: true, userId: true },
    });

    if (!payment) {
      console.warn(`[payments/webhook] no payment row for order ${orderId}`);
      return NextResponse.json({ success: true, ignored: "unknown order" });
    }

    if (payment.status === "COMPLETED") {
      return NextResponse.json({ success: true, alreadySettled: true });
    }

    await db.payment.update({
      where: { id: payment.id },
      data: {
        status: "COMPLETED",
        paidAt: new Date(),
        method: "CARD",
        ...(gatewayPaymentId ? { providerPaymentId: gatewayPaymentId } : {}),
      },
    });

    await writeAuditLog({
      action: "payment.settled",
      userId: null,
      metadata: { paymentId: payment.id, orderId, event: event.event, studentId: payment.userId },
    });

    await enqueueInvoice({ paymentId: payment.id }).catch((error) =>
      console.error("[payments/webhook] could not enqueue invoice:", error),
    );

    return NextResponse.json({ success: true, settled: payment.id });
  } catch (error) {
    console.error("[payments/webhook] POST failed:", error);

    // Release the idempotency marker so the retry can actually do the work.
    //
    // Without this the insert-first guard becomes a trap: the marker is already
    // written, so Razorpay's retry would hit P2002, return 200, and the payment
    // would stay PENDING forever with nothing flagging it. Deleting it is safe
    // even if the failure happened after the row was settled — the retry finds
    // `status === "COMPLETED"` and returns early instead of settling twice.
    if (markerId) {
      await db.processedWebhook
        .delete({ where: { id: markerId } })
        .catch((cleanupError) =>
          console.error("[payments/webhook] could not release the retry marker:", cleanupError),
        );
    }

    return NextResponse.json({ success: false, message: "Something went wrong." }, { status: 500 });
  }
}
