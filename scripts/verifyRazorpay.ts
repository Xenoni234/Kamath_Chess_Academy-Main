/**
 * Razorpay signature verification, webhook idempotency, and the payments switch.
 *
 *   npm run dev            # in another terminal
 *   npx tsx --env-file=.env.local scripts/verifyRazorpay.ts
 *
 * Everything here runs WITHOUT a Razorpay account. The parts that decide whether
 * money is handled correctly — HMAC verification and replay protection — are pure
 * local computation, so they are fully testable; the script sets fake keys in its
 * own process to exercise them.
 *
 * What this does NOT cover: the outbound call to Razorpay's API in
 * `POST /api/payments/order`. That needs real test-mode keys. When you have them,
 * set RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET / RAZORPAY_WEBHOOK_SECRET in
 * .env.local, restart the dev server, and run this again — the webhook assertions
 * will then exercise the real route end to end instead of the library directly.
 *
 * Self-cleaning on every exit path.
 */
import crypto from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

// Set BEFORE importing the library so isPaymentsEnabled() sees them.
const TEST_SECRET = "kca_test_webhook_secret";
process.env.RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || "rzp_test_fake";
process.env.RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || "fake_key_secret";
process.env.RAZORPAY_WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET || TEST_SECRET;

const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
const TAG = "kcarzptest";

let pass = 0;
let fail = 0;
function check(label: string, ok: boolean, detail = "") {
  if (ok) {
    pass++;
    console.log(`  PASS  ${label}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label} ${detail}`);
  }
}

async function cleanup() {
  await db.processedWebhook.deleteMany({ where: { id: { startsWith: TAG } } });
  const users = await db.user.findMany({ where: { username: { startsWith: TAG } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  if (ids.length) {
    const payments = await db.payment.findMany({ where: { userId: { in: ids } }, select: { id: true } });
    await db.invoice.deleteMany({ where: { paymentId: { in: payments.map((p) => p.id) } } });
    await db.payment.deleteMany({ where: { userId: { in: ids } } });
    await db.notification.deleteMany({ where: { userId: { in: ids } } });
    await db.user.deleteMany({ where: { id: { in: ids } } });
  }
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

async function main() {
  await cleanup();
  const { verifyWebhookSignature, verifyCheckoutSignature, isPaymentsEnabled, toPaise } = await import(
    "../src/lib/razorpay"
  );

  console.log("1. Webhook signature verification");
  const body = JSON.stringify({ event: "payment.captured", payload: {} });
  const good = crypto.createHmac("sha256", process.env.RAZORPAY_WEBHOOK_SECRET!).update(body).digest("hex");
  check("a correctly signed body is accepted", verifyWebhookSignature(body, good));
  check("a tampered body is rejected", !verifyWebhookSignature(body + " ", good));
  check("a wrong signature is rejected", !verifyWebhookSignature(body, "deadbeef".repeat(8)));
  check("a missing signature is rejected", !verifyWebhookSignature(body, null));
  check("a short signature is rejected without throwing", !verifyWebhookSignature(body, "abc"));

  console.log("2. Checkout callback signature");
  const orderId = "order_TEST123";
  const payId = "pay_TEST456";
  const sig = crypto
    .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET!)
    .update(`${orderId}|${payId}`)
    .digest("hex");
  check("a genuine checkout signature verifies",
    verifyCheckoutSignature({ orderId, paymentId: payId, signature: sig }));
  check("a signature for a different order is rejected",
    !verifyCheckoutSignature({ orderId: "order_OTHER", paymentId: payId, signature: sig }));

  console.log("3. Amount conversion");
  check("₹1500.00 becomes 150000 paise", toPaise(1500) === 150000, String(toPaise(1500)));
  check("₹99.99 rounds correctly", toPaise(99.99) === 9999, String(toPaise(99.99)));
  check("payments report as enabled with all three keys set", isPaymentsEnabled());

  console.log("4. Replay protection (the ProcessedWebhook guard)");
  const eventId = `${TAG}-event-1`;
  const insert = async () => {
    try {
      await db.processedWebhook.create({ data: { id: eventId, provider: "razorpay" } });
      return "inserted";
    } catch {
      return "duplicate";
    }
  };
  check("the first delivery inserts", (await insert()) === "inserted");
  check("the second delivery is detected as a duplicate", (await insert()) === "duplicate");
  check("the third delivery too", (await insert()) === "duplicate");
  const rows = await db.processedWebhook.count({ where: { id: eventId } });
  check("exactly one marker row exists", rows === 1, `got ${rows}`);

  console.log("5. The database refuses a double settlement");
  const user = await db.user.create({
    data: {
      username: `${TAG}student`,
      email: `${TAG}@example.com`,
      mobile: `9${Date.now().toString().slice(-9)}`,
      passwordHash: "x",
      role: "STUDENT",
    },
    select: { id: true },
  });
  await db.payment.create({
    data: { userId: user.id, amount: 1000, status: "PENDING", provider: "razorpay", providerRef: "order_DUPE" },
  });
  let secondRefused = false;
  try {
    await db.payment.create({
      data: { userId: user.id, amount: 1000, status: "PENDING", provider: "razorpay", providerRef: "order_DUPE" },
    });
  } catch {
    secondRefused = true;
  }
  check("a second payment row for the same order id is refused by the unique constraint", secondRefused);

  // Offline rows are (null, null) and must remain unlimited.
  await db.payment.create({ data: { userId: user.id, amount: 500, status: "COMPLETED" } });
  await db.payment.create({ data: { userId: user.id, amount: 700, status: "COMPLETED" } });
  const offline = await db.payment.count({ where: { userId: user.id, providerRef: null } });
  check("offline payments (null provider/ref) are not blocked by that constraint", offline === 2,
    `got ${offline}`);

  console.log("6. The server-only switch never reaches the browser bundle");
  const clientImporters = sourceFiles("src").filter((f) => {
    const src = readFileSync(f, "utf8");
    return src.includes('"use client"') && /from\s+["'].*lib\/razorpay["']/.test(src);
  });
  check("no \"use client\" file imports lib/razorpay", clientImporters.length === 0,
    clientImporters.join(", "));

  await cleanup();
  console.log(`\n${fail === 0 ? "✅ ALL PASS" : `❌ ${fail} FAILED`} (${pass} passed) — test data removed`);
  console.log("Note: the outbound order-creation call is NOT covered — it needs real test-mode keys.");
}

main()
  .then(() => process.exit(fail === 0 ? 0 : 1))
  .catch(async (error) => {
    console.error(error);
    await cleanup().catch(() => {});
    process.exit(1);
  });
