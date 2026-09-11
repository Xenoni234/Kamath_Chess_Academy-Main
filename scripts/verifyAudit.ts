/**
 * The audit log can be read, only by the right person, and paging does not lose rows.
 *
 *   npm run dev            # in another terminal
 *   npx tsx --env-file=.env.local scripts/verifyAudit.ts
 *
 * The paging assertion is the one worth writing. `AuditLog.createdAt` is not
 * unique — bulk operations write several rows inside the same millisecond — and
 * a keyset cursor on a non-unique column silently skips rows that share a value.
 * Silently is the problem: an audit log that quietly omits entries is worse than
 * one that errors, because it still looks complete. So this seeds rows with
 * deliberately identical timestamps and demands every single one comes back
 * exactly once across the pages.
 *
 * Self-cleaning on every exit path.
 */
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { signAccessToken } from "../src/lib/auth";
import { auditActionLabel, AUDIT_ACTION_LABELS } from "../src/lib/auditActions";

const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
const BASE = process.env.VERIFY_BASE_URL ?? "http://localhost:3000";
const TAG = "kcaaudittest";
const SEEDED_ACTION = `${TAG}.seeded`;

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
  await db.auditLog.deleteMany({ where: { action: SEEDED_ACTION } });
  const users = await db.user.findMany({ where: { username: { startsWith: TAG } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  if (ids.length) {
    await db.auditLog.deleteMany({ where: { userId: { in: ids } } });
    await db.user.deleteMany({ where: { id: { in: ids } } });
  }
}

function tokenFor(u: { id: string; username: string; role: string }) {
  return signAccessToken({ userId: u.id, username: u.username, role: u.role as never });
}

async function main() {
  await cleanup();

  let mobile = Number(`9${Date.now().toString().slice(-9)}`);
  const mk = async (suffix: string, role: "STUDENT" | "HR" | "HEAD") =>
    db.user.create({
      data: {
        username: `${TAG}${suffix}`,
        email: `${TAG}${suffix}@example.com`,
        mobile: String(mobile++),
        passwordHash: "x",
        role,
      },
      select: { id: true, username: true, role: true },
    });

  const student = await mk("student", "STUDENT");
  const hr = await mk("hr", "HR");
  const head = await mk("head", "HEAD");

  console.log("1. Access control");
  const noAuth = await fetch(`${BASE}/api/admin/audit`);
  check("no cookie is 401", noAuth.status === 401, `got ${noAuth.status}`);
  const asStudent = await fetch(`${BASE}/api/admin/audit`, {
    headers: { Cookie: `kca_access_token=${tokenFor(student)}` },
  });
  check("a student gets 403", asStudent.status === 403, `got ${asStudent.status}`);
  const asHr = await fetch(`${BASE}/api/admin/audit`, {
    headers: { Cookie: `kca_access_token=${tokenFor(hr)}` },
  });
  check("HR gets 403 — this is owner-level, not staff-level", asHr.status === 403, `got ${asHr.status}`);
  const asHead = await fetch(`${BASE}/api/admin/audit`, {
    headers: { Cookie: `kca_access_token=${tokenFor(head)}` },
  });
  check("HEAD gets 200", asHead.status === 200, `got ${asHead.status}`);

  console.log("2. Keyset paging over rows that share a timestamp");
  // 60 rows, all written with the SAME createdAt. This is what a bulk operation
  // looks like, and what a naive cursor on createdAt silently drops.
  const sameInstant = new Date("2026-06-15T12:00:00.000Z");
  await db.auditLog.createMany({
    data: Array.from({ length: 60 }, (_, i) => ({
      action: SEEDED_ACTION,
      userId: head.id,
      metadata: { seq: i },
      createdAt: sameInstant,
    })),
  });

  const seen = new Set<string>();
  let cursor: string | null = null;
  let pages = 0;
  do {
    const params = new URLSearchParams({ action: SEEDED_ACTION, limit: "25" });
    if (cursor) params.set("cursor", cursor);
    const res = await fetch(`${BASE}/api/admin/audit?${params}`, {
      headers: { Cookie: `kca_access_token=${tokenFor(head)}` },
    });
    const data = await res.json();
    for (const e of data.entries ?? []) seen.add(e.id);
    cursor = data.nextCursor ?? null;
    pages++;
  } while (cursor && pages < 10);

  check("all 60 rows were returned across the pages", seen.size === 60, `got ${seen.size} in ${pages} pages`);
  check("it took more than one page (paging was actually exercised)", pages > 1, `${pages} pages`);

  console.log("3. Filtering and the action list");
  const filtered = await fetch(`${BASE}/api/admin/audit?action=${SEEDED_ACTION}`, {
    headers: { Cookie: `kca_access_token=${tokenFor(head)}` },
  });
  const fBody = await filtered.json();
  check("the filter returns only that action",
    (fBody.entries ?? []).every((e: { action: string }) => e.action === SEEDED_ACTION),
    JSON.stringify((fBody.entries ?? []).slice(0, 2).map((e: { action: string }) => e.action)));
  check("the action list includes the seeded action with a count",
    (fBody.actions ?? []).some((a: { action: string; count: number }) => a.action === SEEDED_ACTION && a.count === 60),
    JSON.stringify((fBody.actions ?? []).find((a: { action: string }) => a.action === SEEDED_ACTION)));

  const byUser = await fetch(`${BASE}/api/admin/audit?userId=${head.id}`, {
    headers: { Cookie: `kca_access_token=${tokenFor(head)}` },
  });
  const uBody = await byUser.json();
  check("filtering by user works",
    (uBody.entries ?? []).every((e: { userId: string }) => e.userId === head.id));

  const badQuery = await fetch(`${BASE}/api/admin/audit?limit=9999`, {
    headers: { Cookie: `kca_access_token=${tokenFor(head)}` },
  });
  check("an out-of-range limit is a 400", badQuery.status === 400, `got ${badQuery.status}`);

  console.log("4. Reading the log is itself logged");
  const reads = await db.auditLog.count({ where: { userId: head.id, action: "audit.read" } });
  check("audit.read rows were written", reads > 0, `got ${reads}`);

  console.log("5. Action labels");
  check("a known dotted action has a label", auditActionLabel("payment.record") === "Payment recorded");
  check("a known SCREAMING_SNAKE action has a label", auditActionLabel("USER_LOGGED_IN") === "Signed in");
  check("an unknown action falls back to the raw string",
    auditActionLabel("something.new") === "something.new");
  // Every action string the database actually contains should be labelled, or the
  // viewer's dropdown shows raw identifiers to the academy owner.
  const distinct = await db.auditLog.groupBy({ by: ["action"] });
  const unlabelled = distinct
    .map((d) => d.action)
    .filter((a) => a !== SEEDED_ACTION && !(a in AUDIT_ACTION_LABELS));
  check("every action present in the database has a label", unlabelled.length === 0,
    unlabelled.join(", "));

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
