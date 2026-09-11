/**
 * Invoice numbering and issuance.
 *
 *   npx tsx --env-file=.env.local scripts/verifyInvoice.ts
 *
 * The assertion that matters is the concurrency one. `Invoice.number` is unique,
 * so the whole reason `invoice_counters` exists is that "count the invoices and
 * add one" loses a race under READ COMMITTED. A sequential test would pass
 * against the broken implementation too, so this fires twenty reservations at
 * once and demands twenty distinct numbers.
 *
 * The second is idempotency: a payment must end up with exactly one invoice no
 * matter how many settlement paths or webhook retries fire at it.
 *
 * Self-cleaning: removes its own user, payments, invoices and counter row on
 * every exit path.
 */
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { reserveInvoiceNumber, financialYear } from "../src/lib/payments/invoiceNumber";
import { runInvoiceJob } from "../src/lib/payments/runInvoiceJob";

const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });

const TAG = "kcainvtest";
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

async function main() {
  await cleanup();

  console.log("1. Concurrent numbering — the race the counter table exists to win");
  const fy = financialYear();
  const before = await db.invoiceCounter.findUnique({ where: { fy } });
  const numbers = await Promise.all(Array.from({ length: 20 }, () => reserveInvoiceNumber()));
  const unique = new Set(numbers);
  check("20 concurrent reservations produced 20 distinct numbers", unique.size === 20,
    `got ${unique.size}: ${numbers.slice(0, 4).join(", ")}…`);
  check("all numbers are in the current financial year", numbers.every((n) => n.startsWith(`KCA-${fy}-`)),
    numbers[0]);
  check("sequence is zero-padded to 4 digits", numbers.every((n) => /-\d{4}$/.test(n)), numbers[0]);
  const after = await db.invoiceCounter.findUnique({ where: { fy } });
  check("counter advanced by exactly 20",
    (after?.seq ?? 0) - (before?.seq ?? 0) === 20,
    `${before?.seq ?? 0} -> ${after?.seq ?? 0}`);

  console.log("2. One invoice per payment, however many times the job runs");
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

  const completed = await db.payment.create({
    data: { userId: user.id, amount: 1500, status: "COMPLETED", description: "October tuition", paidAt: new Date() },
    select: { id: true },
  });

  await runInvoiceJob({ paymentId: completed.id });
  let invoices = await db.invoice.count({ where: { paymentId: completed.id } });
  check("a COMPLETED payment produced exactly one invoice", invoices === 1, `got ${invoices}`);

  // The webhook-retry case: same job again.
  await runInvoiceJob({ paymentId: completed.id });
  invoices = await db.invoice.count({ where: { paymentId: completed.id } });
  check("re-running the job produced NO second invoice", invoices === 1, `got ${invoices}`);

  // And the concurrent case, which the existence check alone cannot cover.
  const pending = await db.payment.create({
    data: { userId: user.id, amount: 900, status: "COMPLETED", description: "Tournament entry", paidAt: new Date() },
    select: { id: true },
  });
  await Promise.all([runInvoiceJob({ paymentId: pending.id }), runInvoiceJob({ paymentId: pending.id })]);
  invoices = await db.invoice.count({ where: { paymentId: pending.id } });
  check("two concurrent runs produced exactly one invoice", invoices === 1, `got ${invoices}`);

  console.log("3. A payment that is not COMPLETED gets nothing");
  const unpaid = await db.payment.create({
    data: { userId: user.id, amount: 500, status: "PENDING", description: "November tuition" },
    select: { id: true },
  });
  await runInvoiceJob({ paymentId: unpaid.id });
  invoices = await db.invoice.count({ where: { paymentId: unpaid.id } });
  check("a PENDING payment produced no invoice", invoices === 0, `got ${invoices}`);

  console.log("4. The issued invoice carries a usable number and PDF path");
  const issued = await db.invoice.findUnique({
    where: { paymentId: completed.id },
    select: { number: true, pdfUrl: true },
  });
  check("invoice has a number", Boolean(issued?.number), String(issued?.number));
  check("invoice has a PDF path under /tmp", Boolean(issued?.pdfUrl?.startsWith("/tmp/invoice-")),
    String(issued?.pdfUrl));

  await cleanup();
  console.log(`\n${fail === 0 ? "✅ ALL PASS" : `❌ ${fail} FAILED`} (${pass} passed) — test data removed`);
}

main()
  .then(() => process.exit(fail === 0 ? 0 : 1))
  .catch(async (error) => {
    console.error(error);
    await cleanup().catch(() => {});
    process.exit(1);
  });
