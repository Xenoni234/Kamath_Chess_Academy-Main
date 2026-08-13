/**
 * Razorpay — SCAFFOLD, INTENTIONALLY INACTIVE.
 *
 * The academy runs FREE for the first ~3 months (free testing period), so no
 * payment flow is wired up and nothing in the app charges. This file only
 * reserves the shape so activating payments later is a small, contained job.
 *
 * To activate payments when the free period ends:
 *   1. `npm i razorpay`
 *   2. Add to .env.local:  RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET
 *   3. Build `POST /api/payments/order` (create order + PENDING Payment row) and
 *      `POST /api/payments/webhook` (verify the HMAC signature, then mark the
 *      Payment COMPLETED and enqueue an invoice job on INVOICE_QUEUE — the queue
 *      from src/lib/queue is already in place).
 *   4. Gate any payment UI behind `isPaymentsEnabled()` so the site auto-stays
 *      free until all three env vars are present.
 *
 * `Payment` / `Invoice` Prisma models and the durable queue already exist, so
 * no schema or infra work is needed to switch this on.
 */
export function isPaymentsEnabled(): boolean {
  return Boolean(
    process.env.RAZORPAY_KEY_ID &&
      process.env.RAZORPAY_KEY_SECRET &&
      process.env.RAZORPAY_WEBHOOK_SECRET,
  );
}
