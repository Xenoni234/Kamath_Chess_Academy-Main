import { NextResponse } from "next/server";

/**
 * The 429 every metered route returns.
 *
 * Kept apart from `rateLimit.ts` on purpose: that module is deliberately free of any
 * `next/server` import so `scripts/verifyLoginThrottle.ts` can exercise the limiting maths
 * offline, with no framework loaded. The response shape belongs with the routes, the counting
 * belongs with the counter.
 *
 * The default message says nothing about WHICH budget ran out. On the login route the budgets
 * are per-address and per-account, and "too many attempts for this account" would confirm that
 * the account exists — which is the same enumeration leak `compareAgainstDecoy` closes on the
 * timing side.
 */
export function tooManyRequests(
  retryAfterSeconds: number,
  message = "Too many requests. Please wait a few minutes and try again.",
) {
  return NextResponse.json(
    { success: false, message },
    { status: 429, headers: { "Retry-After": String(Math.max(1, Math.ceil(retryAfterSeconds))) } },
  );
}
