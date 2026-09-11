/**
 * End-to-end registration against a running server.
 *
 *   npm run dev            # in another terminal
 *   npx tsx --env-file=.env.local scripts/verifyRegistration.ts
 *
 * This is the path that was completely broken before launch: nothing called
 * /api/auth/otp/send, so no code row was ever created and every real sign-up
 * returned 400. The `NODE_ENV === "development" && otp === "000000"` bypass hid
 * it. Both are fixed — this script is what keeps them fixed.
 *
 * It asserts the whole chain: a code is issued and stored lowercased (a
 * mixed-case address used to be able to receive a code it could never redeem),
 * a wrong code is refused, the right code creates a verified STUDENT, login
 * works, and the code row is consumed so it cannot be replayed.
 *
 * Self-cleaning: the test account and its code rows are removed on every exit
 * path, including failure.
 *
 * Note: step 3 rewrites the stored hash to a code this script knows. The code
 * itself is unrecoverable by design (bcrypt of crypto.randomInt) — rewriting the
 * hash is what makes the REGISTER path testable without reading the email.
 */
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import bcrypt from "bcryptjs";

const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
const BASE = "http://localhost:3000";
// Mixed case on purpose: the lowercase-on-both-sides fix is what this proves.
/**
 * A DELIVERABLE address, mixed-case on purpose.
 *
 * This test drives the real /api/auth/otp/send endpoint, so the address has to
 * be one the mail provider will actually accept — otherwise the send correctly
 * fails, the unusable code row is correctly deleted, and the test fails for a
 * reason that has nothing to do with registration.
 *
 * Defaults to the Resend account owner, which is the only address the test
 * sender will deliver to. Override with VERIFY_EMAIL once a sending domain is
 * verified. The mixed case is the point of the first assertion: a capitalised
 * address used to be able to receive a code it could never redeem.
 */
const EMAIL = process.env.VERIFY_EMAIL ?? "Gyaneshwarofficial2021@gmail.com";
const LOWER = EMAIL.toLowerCase();
const PASSWORD = "Str0ng!TestPass2026";
const USERNAME = "kcaverifytest";

let pass = 0, fail = 0;
function check(label: string, ok: boolean, detail = "") {
  if (ok) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label} ${detail}`); }
}

/**
 * Ids this run created. Cleanup removes ONLY these.
 *
 * This used to delete by email — `deleteMany({ where: { email: LOWER } })` — and
 * that destroyed a real account. When the test address changed to a deliverable
 * one (it has to be, since the endpoint really sends), the email it cleans up
 * became a REAL user's email, and every run silently deleted that person along
 * with everything cascading from them.
 *
 * A test may delete what it made. It may never delete by a field a real row
 * could also match.
 */
const createdUserIds = new Set<string>();

async function cleanup() {
  // OTP rows are safe to clear by address: they are short-lived, single-purpose,
  // and a stale one would only block the next run.
  await db.otpVerification.deleteMany({ where: { email: LOWER, purpose: "register" } });

  if (createdUserIds.size === 0) return;
  const ids = [...createdUserIds];
  await db.auditLog.deleteMany({ where: { userId: { in: ids } } });
  await db.userSession.deleteMany({ where: { userId: { in: ids } } });
  await db.studentProfile.deleteMany({ where: { userId: { in: ids } } });
  await db.user.deleteMany({ where: { id: { in: ids } } });
  createdUserIds.clear();
}

/** Refuse to run if the test address already belongs to somebody. */
async function assertAddressIsFree(): Promise<boolean> {
  const existing = await db.user.findUnique({ where: { email: LOWER }, select: { id: true, username: true } });
  if (!existing) return true;
  console.log(`  ABORT  ${LOWER} already belongs to "${existing.username}".`);
  console.log("         This test registers and then deletes that address, so it will not touch");
  console.log("         a real account. Set VERIFY_EMAIL to an address nobody is using.");
  return false;
}

async function main() {
  if (!(await assertAddressIsFree())) {
    fail++;
    return;
  }
  await cleanup();

  console.log(`1. Request an OTP (mixed-case address: ${EMAIL})`);
  const send = await fetch(`${BASE}/api/auth/otp/send`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, purpose: "register" }),
  });
  const sendBody = await send.json().catch(() => ({}));
  console.log(`     status ${send.status} ${JSON.stringify(sendBody).slice(0, 160)}`);

  if (send.status === 429) {
    console.log("     Rate limited from an earlier run — not a product failure.");
    console.log("     Wait an hour, or clear the `rate:otp:ip:*` key in Redis, then re-run.");
    return;
  }

  const row = await db.otpVerification.findFirst({
    where: { email: LOWER, purpose: "register" }, orderBy: { createdAt: "desc" },
  });
  check("an OtpVerification row was created", Boolean(row));
  check("row email is lowercased", row?.email === LOWER, `got ${row?.email}`);
  if (!row) { console.log("\nCannot continue without a code row."); return; }

  // Recover the plaintext code by brute-force over the 900k space is too slow;
  // instead re-issue a known code directly so the REGISTER path is what we test.
  const known = "424242";
  await db.otpVerification.update({
    where: { id: row.id },
    data: { otpHash: await bcrypt.hash(known, 10) },
  });

  console.log("2. Register with a WRONG code (must be rejected)");
  const bad = await fetch(`${BASE}/api/auth/register`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: USERNAME, email: EMAIL, mobile: "9876500011", password: PASSWORD,
      confirmPassword: PASSWORD, otp: "000000",
      agreedToTerms: true, agreedToAge: true, agreedToDataProcessing: true,
    }),
  });
  check("wrong OTP rejected (no 000000 bypass)", bad.status >= 400, `got ${bad.status}`);
  const noUser = await db.user.findFirst({ where: { email: LOWER } });
  check("no account created by the wrong code", !noUser);

  console.log("3. Register with the CORRECT code");
  const ok = await fetch(`${BASE}/api/auth/register`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: USERNAME, email: EMAIL, mobile: "9876500011", password: PASSWORD,
      confirmPassword: PASSWORD, otp: known,
      agreedToTerms: true, agreedToAge: true, agreedToDataProcessing: true,
    }),
  });
  const okBody = await ok.json().catch(() => ({}));
  check("registration succeeded", ok.status < 400, `got ${ok.status} ${JSON.stringify(okBody).slice(0, 200)}`);

  const user = await db.user.findFirst({ where: { email: LOWER } });
  if (user) createdUserIds.add(user.id);
  check("account exists", Boolean(user));
  check("account is STUDENT", user?.role === "STUDENT", `got ${user?.role}`);
  check("account isVerified === true", user?.isVerified === true, `got ${user?.isVerified}`);

  console.log("4. Log in with the new account");
  const login = await fetch(`${BASE}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier: EMAIL, password: PASSWORD }),
  });
  const loginBody = await login.json().catch(() => ({}));
  check("login succeeded", login.status < 400, `got ${login.status} ${JSON.stringify(loginBody).slice(0, 200)}`);
  check("session cookie set", (login.headers.get("set-cookie") ?? "").includes("kca_access_token"));

  console.log("5. OTP is single-use");
  const reuse = await db.otpVerification.findFirst({ where: { email: LOWER, purpose: "register" } });
  check("code row consumed", !reuse, "row still present");

  await cleanup();
  console.log(`\n${fail === 0 ? "✅ ALL PASS" : "❌ " + fail + " FAILED"} (${pass} passed) — test account removed`);
}

main().then(() => process.exit(0)).catch(async (e) => { console.error(e); await cleanup(); process.exit(1); });
