/**
 * Coach and staff accounts cannot be created without a code, and a code works once.
 *
 *   npm run dev            # in another terminal
 *   npx tsx --env-file=.env.local scripts/verifyInviteCodes.ts
 *
 * The assertion this file exists for is the concurrent one. "Single use" is easy
 * to implement wrongly — read the row, see it is unused, then write — and a
 * sequential test passes against that broken version every time. Two people
 * redeeming the same code at the same instant is the case that separates a real
 * guard from a decorative one, so the test fires both registrations at once and
 * demands exactly one staff account exists afterwards.
 *
 * The rest is the boundary: no code, wrong code, wrong role, expired, withdrawn,
 * already spent — every one of them must refuse to create an account.
 *
 * Self-cleaning on every exit path.
 */
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import bcrypt from "bcryptjs";
import { signAccessToken } from "../src/lib/auth";

const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
const BASE = process.env.VERIFY_BASE_URL ?? "http://localhost:3000";
const TAG = "kcainv";
const PASSWORD = "Str0ng!TestPass2026";
const CODE = "424242";

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
  await db.inviteCode.deleteMany({ where: { note: { startsWith: TAG } } });
  if (ids.length) {
    await db.inviteCode.deleteMany({ where: { OR: [{ createdById: { in: ids } }, { usedById: { in: ids } }] } });
    await db.otpVerification.deleteMany({ where: { email: { contains: TAG } } });
    await db.auditLog.deleteMany({ where: { userId: { in: ids } } });
    await db.studentProfile.deleteMany({ where: { userId: { in: ids } } });
    await db.user.deleteMany({ where: { id: { in: ids } } });
  }
  await db.otpVerification.deleteMany({ where: { email: { contains: TAG } } });
}

// Usernames are capped at 20 characters. The first version of this test used a
// 13-character tag plus a growing counter, so once it reached double digits every
// registration failed Zod validation with a 400 — and the assertions that EXPECTED
// a 400 passed for entirely the wrong reason. Hence the short tag, and hence the
// invite-specific checks below assert the message, not just the status.
const RUN = Date.now().toString().slice(-6);
let seq = 0;
/** Seed a redeemable OTP directly — /api/auth/otp/send is rate limited and this
 *  test is not about OTP issuance. verifyRegistration covers that. */
async function register(opts: { role: string; inviteCode?: string }) {
  seq++;
  const suffix = `${RUN}${String(seq).padStart(2, "0")}`;
  const email = `${TAG}${suffix}@example.com`;
  await db.otpVerification.create({
    data: {
      email,
      otpHash: await bcrypt.hash(CODE, 10),
      purpose: "register",
      expiresAt: new Date(Date.now() + 600000),
      attempts: 0,
    },
  });
  const res = await fetch(`${BASE}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: `${TAG}${suffix}`,
      email,
      mobile: `9${suffix.padStart(9, "0").slice(-9)}`,
      password: PASSWORD,
      confirmPassword: PASSWORD,
      otp: CODE,
      role: opts.role,
      ...(opts.inviteCode === undefined ? {} : { inviteCode: opts.inviteCode }),
      agreedToTerms: true,
      agreedToAge: true,
      agreedToDataProcessing: true,
    }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function main() {
  await cleanup();

  const head = await db.user.findFirst({ where: { role: "HEAD" }, select: { id: true, username: true, role: true } });
  if (!head) {
    console.log("  FAIL  no HEAD account exists — run scripts/setHeadPassword.ts first");
    fail++;
    return;
  }
  const headCookie = `kca_access_token=${signAccessToken({ userId: head.id, username: head.username, role: head.role })}`;

  async function mint(role: "COACH" | "HR", extra: Record<string, unknown> = {}) {
    const res = await fetch(`${BASE}/api/admin/invite-codes`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: headCookie },
      body: JSON.stringify({ role, note: `${TAG} fixture`, ...extra }),
    });
    const body = await res.json().catch(() => ({}));
    return { status: res.status, code: body.code as string | undefined, id: body.id as string | undefined };
  }

  console.log("1. A student still needs no invite code");
  check("STUDENT with no invite code succeeds", (await register({ role: "STUDENT" })).status === 201);
  // PARENT is deliberately not exercised here. It needs no INVITE code, but it
  // does need a parent claim (the student's username and their parent code),
  // which is verifyParentCode's subject rather than this file's.

  console.log("2. Coach and staff cannot register without one");
  const noCode = await register({ role: "COACH" });
  check("COACH with no code is rejected", noCode.status === 400, `got ${noCode.status}`);
  const blank = await register({ role: "HR", inviteCode: "   " });
  check("HR with a blank code is rejected", blank.status === 400, `got ${blank.status}`);
  const bogus = await register({ role: "COACH", inviteCode: "KCA-XXXX-XXXX" });
  check("an unrecognised code is rejected", bogus.status === 400, `got ${bogus.status}`);
  const staffMade = await db.user.count({
    where: { username: { startsWith: TAG }, role: { in: ["COACH", "HR"] } },
  });
  check("NO coach or staff account was created by any of those", staffMade === 0, `found ${staffMade}`);

  console.log("3. Only the head can mint codes");
  const student = await db.user.findFirst({
    where: { username: { startsWith: TAG }, role: "STUDENT" },
    select: { id: true, username: true, role: true },
  });
  const asStudent = await fetch(`${BASE}/api/admin/invite-codes`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: `kca_access_token=${signAccessToken({ userId: student!.id, username: student!.username, role: student!.role })}`,
    },
    body: JSON.stringify({ role: "COACH" }),
  });
  check("a student gets 403 minting a code", asStudent.status === 403, `got ${asStudent.status}`);
  const anon = await fetch(`${BASE}/api/admin/invite-codes`, { method: "POST", body: "{}" });
  check("no cookie gets 401", anon.status === 401, `got ${anon.status}`);

  console.log("4. A valid code works, exactly once");
  const coachCode = await mint("COACH");
  check("the head can mint a code", coachCode.status === 201 && Boolean(coachCode.code), String(coachCode.status));
  check("the code looks like KCA-XXXX-XXXX", /^KCA-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(coachCode.code ?? ""),
    String(coachCode.code));

  const used = await register({ role: "COACH", inviteCode: coachCode.code! });
  check("registering with it succeeds", used.status === 201, `got ${used.status}`);
  check("and the account really is a COACH",
    (used.body.user as { role?: string })?.role === "COACH",
    String((used.body.user as { role?: string })?.role));

  const reuse = await register({ role: "COACH", inviteCode: coachCode.code! });
  check("the SAME code cannot be used again, FOR BEING SPENT",
    reuse.status === 400 && String(reuse.body.message).includes("already been used"),
    `${reuse.status} ${JSON.stringify(reuse.body.message)}`);

  const row = await db.inviteCode.findUnique({
    where: { code: coachCode.code! },
    select: { usedAt: true, usedBy: { select: { username: true } } },
  });
  check("the code records who spent it", Boolean(row?.usedAt && row?.usedBy), JSON.stringify(row));

  console.log("5. Lowercase entry still works (people retype these)");
  const lower = await mint("COACH");
  const lowerUse = await register({ role: "COACH", inviteCode: lower.code!.toLowerCase() });
  check("a lowercased code is accepted", lowerUse.status === 201, `got ${lowerUse.status}`);

  console.log("6. A code is bound to its role");
  const hrCode = await mint("HR");
  const wrongRole = await register({ role: "COACH", inviteCode: hrCode.code! });
  check("an HR code cannot create a COACH, FOR THE RIGHT REASON",
    wrongRole.status === 400 && String(wrongRole.body.message).includes("not valid for the role"),
    `${wrongRole.status} ${JSON.stringify(wrongRole.body.message)}`);
  const stillOpen = await db.inviteCode.findUnique({ where: { code: hrCode.code! }, select: { usedAt: true } });
  check("the rejected attempt did NOT spend the code", stillOpen?.usedAt === null, String(stillOpen?.usedAt));
  const rightRole = await register({ role: "HR", inviteCode: hrCode.code! });
  check("the same code works for HR", rightRole.status === 201, `got ${rightRole.status}`);

  console.log("7. Expiry and withdrawal");
  const expired = await mint("COACH", { expiresInDays: 1 });
  await db.inviteCode.update({
    where: { id: expired.id! },
    data: { expiresAt: new Date(Date.now() - 1000) },
  });
  const expiredTry = await register({ role: "COACH", inviteCode: expired.code! });
  check("an expired code is rejected FOR BEING EXPIRED",
    expiredTry.status === 400 && String(expiredTry.body.message).includes("expired"),
    `${expiredTry.status} ${JSON.stringify(expiredTry.body.message)}`);

  const revoked = await mint("COACH");
  const del = await fetch(`${BASE}/api/admin/invite-codes/${revoked.id}`, {
    method: "DELETE",
    headers: { Cookie: headCookie },
  });
  check("the head can withdraw an unused code", del.status === 200, `got ${del.status}`);
  const revokedTry = await register({ role: "COACH", inviteCode: revoked.code! });
  check("a withdrawn code is rejected FOR BEING WITHDRAWN",
    revokedTry.status === 400 && String(revokedTry.body.message).includes("withdrawn"),
    `${revokedTry.status} ${JSON.stringify(revokedTry.body.message)}`);

  const spent = await db.inviteCode.findFirst({ where: { code: coachCode.code! }, select: { id: true } });
  const delUsed = await fetch(`${BASE}/api/admin/invite-codes/${spent!.id}`, {
    method: "DELETE",
    headers: { Cookie: headCookie },
  });
  check("an ALREADY-USED code cannot be withdrawn (409)", delUsed.status === 409, `got ${delUsed.status}`);

  console.log("8. THE RACE — two people redeem one code simultaneously");
  const contested = await mint("COACH");
  const before = await db.user.count({ where: { username: { startsWith: TAG }, role: "COACH" } });
  const [a, b] = await Promise.all([
    register({ role: "COACH", inviteCode: contested.code! }),
    register({ role: "COACH", inviteCode: contested.code! }),
  ]);
  const winners = [a, b].filter((r) => r.status === 201).length;
  check("exactly ONE of the two succeeded", winners === 1, `${a.status} and ${b.status}`);
  const after = await db.user.count({ where: { username: { startsWith: TAG }, role: "COACH" } });
  check("exactly ONE new coach account exists", after - before === 1, `${before} -> ${after}`);
  const contestedRow = await db.inviteCode.findUnique({
    where: { code: contested.code! },
    select: { usedById: true },
  });
  check("the code is bound to a single account", Boolean(contestedRow?.usedById));

  console.log("9. The issuance is audited");
  const audits = await db.auditLog.count({ where: { userId: head.id, action: "invite.create" } });
  check("invite.create rows were written", audits >= 5, `got ${audits}`);
  const leaked = await db.auditLog.findFirst({
    where: { userId: head.id, action: "invite.create" },
    orderBy: { createdAt: "desc" },
    select: { metadata: true },
  });
  check("the audit metadata does NOT contain the code itself",
    !JSON.stringify(leaked?.metadata ?? {}).includes("KCA-"),
    JSON.stringify(leaked?.metadata));

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
