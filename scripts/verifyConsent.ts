/**
 * Consent is recorded at registration, changeable, and never fabricated.
 *
 *   npm run dev            # in another terminal
 *   npx tsx --env-file=.env.local scripts/verifyConsent.ts
 *
 * Registration used to validate the three mandatory DPDPA consents and then throw
 * them away, keeping only the two optional ones inside an audit-log JSON blob. So
 * the academy held no queryable proof that anyone had consented to processing a
 * child's data. These assertions are about that proof existing and staying honest.
 *
 * The sharpest one is the last: an account with no consent record must report as
 * UNKNOWN, never as refused. Those users did tick the boxes — we simply did not
 * keep the record — and rendering that absence as a refusal would be a false
 * statement about a data principal.
 *
 * Self-cleaning on every exit path.
 */
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import bcrypt from "bcryptjs";
import { signAccessToken } from "../src/lib/auth";

const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
const BASE = process.env.VERIFY_BASE_URL ?? "http://localhost:3000";
const TAG = "kcaconsenttest";
const EMAIL = `${TAG}@example.com`;
const LEGACY_EMAIL = `${TAG}legacy@example.com`;
const PASSWORD = "Str0ng!TestPass2026";

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
  await db.otpVerification.deleteMany({ where: { email: { in: [EMAIL, LEGACY_EMAIL] } } });
  const users = await db.user.findMany({
    where: { email: { in: [EMAIL, LEGACY_EMAIL] } },
    select: { id: true },
  });
  const ids = users.map((u) => u.id);
  if (ids.length) {
    await db.auditLog.deleteMany({ where: { userId: { in: ids } } });
    await db.studentProfile.deleteMany({ where: { userId: { in: ids } } });
    await db.user.deleteMany({ where: { id: { in: ids } } });
  }
}

async function main() {
  await cleanup();

  console.log("1. Registration records all seven consent fields");
  await fetch(`${BASE}/api/auth/otp/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, purpose: "register" }),
  });
  const row = await db.otpVerification.findFirst({
    where: { email: EMAIL, purpose: "register" },
    orderBy: { createdAt: "desc" },
  });
  if (!row) {
    console.log("  FAIL  could not issue an OTP — is the dev server running?");
    fail++;
    return;
  }
  const code = "424242";
  await db.otpVerification.update({ where: { id: row.id }, data: { otpHash: await bcrypt.hash(code, 10) } });

  const res = await fetch(`${BASE}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: TAG,
      email: EMAIL,
      mobile: `9${Date.now().toString().slice(-9)}`,
      password: PASSWORD,
      confirmPassword: PASSWORD,
      otp: code,
      agreedToTerms: true,
      agreedToAge: true,
      agreedToDataProcessing: true,
      agreedToMarketing: true,
      agreedToSms: false,
    }),
  });
  check("registration succeeded", res.status < 400, `got ${res.status}`);

  const user = await db.user.findUnique({
    where: { email: EMAIL },
    select: {
      id: true,
      username: true,
      role: true,
      consentVersion: true,
      consentTermsAt: true,
      consentAgeAt: true,
      consentDataProcessingAt: true,
      consentMarketing: true,
      consentMarketingAt: true,
      consentSms: true,
      consentSmsAt: true,
    },
  });
  check("the three MANDATORY consents have timestamps",
    Boolean(user?.consentTermsAt && user?.consentAgeAt && user?.consentDataProcessingAt),
    JSON.stringify({ t: user?.consentTermsAt, a: user?.consentAgeAt, d: user?.consentDataProcessingAt }));
  check("a consent version was stamped", user?.consentVersion === "2026-09", String(user?.consentVersion));
  check("marketing consent recorded as given, with a time",
    user?.consentMarketing === true && Boolean(user?.consentMarketingAt),
    `${user?.consentMarketing} ${user?.consentMarketingAt}`);
  check("SMS consent recorded as NOT given, with no time",
    user?.consentSms === false && user?.consentSmsAt === null,
    `${user?.consentSms} ${user?.consentSmsAt}`);

  console.log("2. The user can read and change their own consent");
  const token = signAccessToken({ userId: user!.id, username: user!.username, role: user!.role });
  const cookie = `kca_access_token=${token}`;

  const get = await fetch(`${BASE}/api/user/consent`, { headers: { Cookie: cookie } });
  const getBody = await get.json().catch(() => ({}));
  check("GET returns the consent state", get.status === 200 && getBody.consent?.recorded === true,
    `${get.status} ${JSON.stringify(getBody).slice(0, 120)}`);

  const patch = await fetch(`${BASE}/api/user/consent`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ marketing: false }),
  });
  check("PATCH withdrawing marketing succeeds", patch.status === 200, `got ${patch.status}`);
  const after = await db.user.findUnique({
    where: { id: user!.id },
    select: { consentMarketing: true, consentMarketingAt: true },
  });
  check("marketing consent is now withdrawn", after?.consentMarketing === false, String(after?.consentMarketing));
  check("the withdrawal was timestamped",
    Boolean(after?.consentMarketingAt && after.consentMarketingAt > user!.consentMarketingAt!),
    `${user?.consentMarketingAt} -> ${after?.consentMarketingAt}`);
  const audited = await db.auditLog.count({ where: { userId: user!.id, action: "consent.update" } });
  check("the change is in the audit log", audited === 1, `got ${audited}`);

  const empty = await fetch(`${BASE}/api/user/consent`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({}),
  });
  check("an empty PATCH is a 400", empty.status === 400, `got ${empty.status}`);

  const noAuth = await fetch(`${BASE}/api/user/consent`);
  check("no cookie is 401", noAuth.status === 401, `got ${noAuth.status}`);

  console.log("3. A pre-consent account reads as UNKNOWN, never as refused");
  const legacy = await db.user.create({
    data: {
      username: `${TAG}legacy`,
      email: LEGACY_EMAIL,
      mobile: `8${Date.now().toString().slice(-9)}`,
      passwordHash: "x",
      role: "STUDENT",
      auditLogs: {
        create: {
          action: "USER_REGISTERED",
          metadata: { marketingEmailConsent: true, smsNotificationConsent: false },
        },
      },
    },
    select: { id: true, username: true, role: true, consentVersion: true, consentMarketing: true },
  });
  check("a legacy account has no consent version", legacy.consentVersion === null, String(legacy.consentVersion));

  const legacyToken = signAccessToken({ userId: legacy.id, username: legacy.username, role: legacy.role });
  const legacyGet = await fetch(`${BASE}/api/user/consent`, {
    headers: { Cookie: `kca_access_token=${legacyToken}` },
  });
  const legacyBody = await legacyGet.json().catch(() => ({}));
  check("the API reports it as NOT recorded (unknown, not refused)",
    legacyBody.consent?.recorded === false, JSON.stringify(legacyBody).slice(0, 120));

  console.log("4. The backfill recovers what the audit log actually knows");
  const { execSync } = await import("node:child_process");
  execSync("npx tsx --env-file=.env.local scripts/backfillConsent.ts --apply", { stdio: "pipe" });
  const filled = await db.user.findUnique({
    where: { id: legacy.id },
    select: { consentVersion: true, consentMarketing: true, consentSms: true, consentTermsAt: true },
  });
  check("backfill stamps it 'legacy-audit', not the current version",
    filled?.consentVersion === "legacy-audit", String(filled?.consentVersion));
  check("marketing was recovered from the audit metadata", filled?.consentMarketing === true,
    String(filled?.consentMarketing));
  check("sms was recovered as false", filled?.consentSms === false, String(filled?.consentSms));
  check("the mandatory consents got a proxy timestamp", Boolean(filled?.consentTermsAt),
    String(filled?.consentTermsAt));

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
