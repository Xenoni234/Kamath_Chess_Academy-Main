/**
 * A rejected email is reported as a failure, not swallowed.
 *
 *   npm run dev            # in another terminal
 *   npx tsx --env-file=.env.local scripts/verifyEmailFailure.ts
 *
 * This exists because of an incident worth remembering. **The Resend SDK does
 * not throw when the API rejects a message** — `emails.send()` resolves with
 * `{ data: null, error }`. Every call site here was written as
 * `await resend.emails.send({...})` with the result thrown away, so a refusal
 * was indistinguishable from a success.
 *
 * What that produced: registration said "Code sent to your@email.com. It expires
 * in 10 minutes", wrote a matching code row, returned 200 — while Resend had
 * answered 403 ("You can only send testing emails to your own email address",
 * because the project was still on the `onboarding@resend.dev` test sender).
 * Nothing was logged. The user waited for an email that could never arrive.
 *
 * So the assertions are about honesty under failure, and they use a genuinely
 * undeliverable address to provoke a real rejection rather than a mocked one:
 *
 *  - `issueOtpCode` reports `success: false`
 *  - the send endpoint does NOT tell the user a code is on its way
 *  - the orphaned code row is removed, so it cannot eat the hourly limit of
 *    someone who retries once the sender is fixed
 *
 * Self-cleaning on every exit path.
 */
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { issueOtpCode } from "../src/lib/otp";
import { sendEmail } from "../src/lib/email";

const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
const BASE = process.env.VERIFY_BASE_URL ?? "http://localhost:3000";

/**
 * An address Resend will refuse.
 *
 * While the project is on the test sender, ANY address other than the account
 * owner's is refused — so this is refused today for that reason, and remains
 * refused after a domain is verified because the domain does not exist.
 */
const UNDELIVERABLE = "kca-verify-bounce@invalid-domain-for-testing.example";

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
  await db.otpVerification.deleteMany({ where: { email: { contains: "invalid-domain-for-testing" } } });
}

async function main() {
  await cleanup();

  console.log("1. sendEmail reports a refusal instead of resolving quietly");
  const direct = await sendEmail({
    to: UNDELIVERABLE,
    subject: "KCA delivery check",
    html: "<p>This message is expected to be refused.</p>",
  });
  check("it returns sent: false", direct.sent === false, JSON.stringify(direct));
  check("and carries the reason", direct.sent === false && direct.error.length > 0,
    direct.sent === false ? direct.error.slice(0, 90) : "");

  console.log("2. issueOtpCode fails when the mail cannot go");
  const issued = await issueOtpCode({ email: UNDELIVERABLE, purpose: "register" });
  check("it returns success: false", issued.success === false, JSON.stringify(issued));

  const left = await db.otpVerification.count({ where: { email: UNDELIVERABLE.toLowerCase() } });
  check("the unreadable code row was cleaned up", left === 0, `${left} row(s) left behind`);

  console.log("3. The send endpoint does not claim a code is on its way");
  const res = await fetch(`${BASE}/api/auth/otp/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: UNDELIVERABLE, purpose: "register" }),
  });
  const body = await res.json().catch(() => ({}));
  check("the response is not a success", res.status >= 400 || body.success === false,
    `${res.status} ${JSON.stringify(body).slice(0, 120)}`);
  const stillLeft = await db.otpVerification.count({ where: { email: UNDELIVERABLE.toLowerCase() } });
  check("still no orphaned code row", stillLeft === 0, `${stillLeft} left`);

  console.log("4. Nothing bypasses the shared sender");
  const { readdirSync, readFileSync, statSync } = await import("node:fs");
  const path = await import("node:path");
  function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) walk(full, out);
      else if (/\.tsx?$/.test(entry)) out.push(full);
    }
    return out;
  }
  const helper = path.normalize("src/lib/email.ts");
  const offenders = walk("src")
    .filter((f) => path.normalize(f) !== helper)
    .filter((f) => /emails\.send\s*\(/.test(readFileSync(f, "utf8")));
  check("no file calls resend.emails.send directly", offenders.length === 0, offenders.join(", "));

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
