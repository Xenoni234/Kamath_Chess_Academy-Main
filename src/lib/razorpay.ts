/**
 * Razorpay integration.
 *
 * **The gateway is off until three environment variables exist.** That is the
 * switch, not a code branch: the academy runs free during its testing period, and
 * `isPaymentsEnabled()` returning false keeps every payment surface hidden and
 * every payment route refusing, with no deploy needed either way. When the
 * merchant account clears KYC you add `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`
 * and `RAZORPAY_WEBHOOK_SECRET`, restart, and it is live.
 *
 * `isPaymentsEnabled()` reads server-only env vars, so it can never be called
 * from a `"use client"` component. The checkout UI receives the flag as a prop
 * from a server component instead — `scripts/verifyRazorpay.ts` asserts no client
 * file imports it, because the failure mode (bundler inlines `false`, checkout
 * silently disappears in production) is invisible.
 *
 * The amount model: students never name their own price. Staff record what is
 * owed as a PENDING Payment, and an order can only be opened against one of those
 * rows, for exactly its amount. A client that posts an amount is not trusted with
 * one.
 */
import crypto from "node:crypto";

export function isPaymentsEnabled(): boolean {
  return Boolean(
    process.env.RAZORPAY_KEY_ID &&
      process.env.RAZORPAY_KEY_SECRET &&
      process.env.RAZORPAY_WEBHOOK_SECRET,
  );
}

/** The publishable key id, for the browser checkout. Null when payments are off. */
export function publishableKeyId(): string | null {
  return isPaymentsEnabled() ? process.env.RAZORPAY_KEY_ID ?? null : null;
}

/**
 * Razorpay's client, constructed lazily.
 *
 * Lazy because the module is imported by routes that must still load when
 * payments are disabled — constructing the client at import time would make a
 * missing key a build-time failure rather than a feature flag.
 */
export async function razorpayClient() {
  if (!isPaymentsEnabled()) throw new Error("Payments are not enabled.");
  const { default: Razorpay } = await import("razorpay");
  return new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID!,
    key_secret: process.env.RAZORPAY_KEY_SECRET!,
  });
}

/**
 * Verify a webhook delivery against `RAZORPAY_WEBHOOK_SECRET`.
 *
 * The signature is computed over the **raw request body**, so the caller must
 * pass the exact bytes received — `JSON.parse` then `JSON.stringify` reorders
 * keys and changes whitespace, and the signature will not match.
 *
 * `timingSafeEqual` rather than `===`: a plain string compare returns early on
 * the first differing byte, which leaks how much of a guessed signature was
 * correct and makes forging one measurably easier.
 */
export function verifyWebhookSignature(rawBody: string, signature: string | null): boolean {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret || !signature) return false;

  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Verify the checkout handler's signature (the browser callback).
 *
 * Separate from the webhook signature: this one is HMAC over
 * `order_id|payment_id` and confirms the browser's success callback is genuine.
 * It is a UX signal only — **the webhook is what actually settles a payment**,
 * because a browser that closes before the callback fires must not lose a
 * payment the gateway already took.
 */
export function verifyCheckoutSignature(params: {
  orderId: string;
  paymentId: string;
  signature: string;
}): boolean {
  const secret = process.env.RAZORPAY_KEY_SECRET;
  if (!secret) return false;

  const expected = crypto
    .createHmac("sha256", secret)
    .update(`${params.orderId}|${params.paymentId}`)
    .digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(params.signature, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** Rupees to paise. Razorpay works in the smallest currency unit. */
export function toPaise(rupees: number): number {
  return Math.round(rupees * 100);
}
