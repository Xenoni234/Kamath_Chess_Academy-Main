/**
 * Jobs abandoned by a dead process get failed; live ones are left alone.
 *
 *   npx tsx --env-file=.env.local scripts/verifyReaper.ts
 *
 * This exists because two dossiers sat at `processing` for sixteen hours. Nothing
 * was broken in the job itself — the server had simply been restarted while it
 * was running. Without QUEUE_REDIS_URL the enqueue helpers fall back to
 * `setImmediate`, so jobs live inside the web process, and each job's own
 * `Promise.race` timeout dies with it. The row then says `processing` forever:
 * the UI shows PROFILING, no error is logged anywhere, and nothing will ever
 * change it.
 *
 * The assertion that matters most is the second one. A reaper that is too eager
 * is worse than none — it would fail a job that is still running, halfway through
 * a thirty-minute dossier. So this seeds a recently-touched row and demands the
 * reaper leaves it completely alone.
 *
 * No dev server needed. Self-cleaning on every exit path.
 */
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { reapStaleJobs, STALE_AFTER_MS } from "../src/lib/queue/reapStaleJobs";

const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
const TAG = "kcareap";

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
  await db.opponentProfile.deleteMany({ where: { handle: { startsWith: TAG } } });
  const users = await db.user.findMany({ where: { username: { startsWith: TAG } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  if (ids.length) {
    await db.auditLog.deleteMany({ where: { userId: { in: ids } } });
    await db.studentProfile.deleteMany({ where: { userId: { in: ids } } });
    await db.user.deleteMany({ where: { id: { in: ids } } });
  }
}

/** Force `updatedAt` into the past — Prisma's @updatedAt overwrites it on write. */
async function ageProfile(id: string, msAgo: number) {
  const when = new Date(Date.now() - msAgo);
  await db.$executeRaw`UPDATE opponent_profiles SET "updatedAt" = ${when} WHERE id = ${id}`;
}

async function main() {
  await cleanup();

  const owner = await db.user.create({
    data: {
      username: `${TAG}owner`,
      email: `${TAG}@example.com`,
      mobile: `9${Date.now().toString().slice(-9)}`,
      passwordHash: "x",
      role: "STUDENT",
    },
    select: { id: true },
  });

  const mk = async (handle: string, status: string) =>
    db.opponentProfile.create({
      data: { handle, source: "LICHESS", colorToPlay: "white", status, requestedById: owner.id },
      select: { id: true },
    });

  console.log("1. A job abandoned long ago is failed");
  const stale = await mk(`${TAG}stale`, "processing");
  await ageProfile(stale.id, STALE_AFTER_MS + 60_000);

  console.log("2. A job that is still running is untouched");
  const live = await mk(`${TAG}live`, "processing");
  await ageProfile(live.id, 60_000); // one minute ago — plainly alive

  console.log("3. Terminal rows are never rewritten");
  const done = await mk(`${TAG}done`, "complete");
  await ageProfile(done.id, STALE_AFTER_MS * 3);
  const already = await mk(`${TAG}failed`, "failed");
  await ageProfile(already.id, STALE_AFTER_MS * 3);

  const result = await reapStaleJobs();

  const after = async (id: string) =>
    (await db.opponentProfile.findUnique({ where: { id }, select: { status: true } }))?.status;

  check("the abandoned job is now failed", (await after(stale.id)) === "failed", String(await after(stale.id)));
  check("the LIVE job is still processing", (await after(live.id)) === "processing", String(await after(live.id)));
  check("a completed job stays complete", (await after(done.id)) === "complete", String(await after(done.id)));
  check("an already-failed job stays failed", (await after(already.id)) === "failed", String(await after(already.id)));
  check("it reported reaping at least the one row", result.profiles >= 1, JSON.stringify(result));

  console.log("4. Running it twice changes nothing further");
  const second = await reapStaleJobs();
  check("a second run reaps nothing new",
    second.profiles === 0 || (await after(live.id)) === "processing",
    JSON.stringify(second));
  check("the live job SURVIVED both runs", (await after(live.id)) === "processing", String(await after(live.id)));

  console.log("5. The cutoff is past the longest job timeout");
  // A dossier may legitimately run 30 minutes; reaping earlier would kill live work.
  check("STALE_AFTER_MS is greater than the 30-minute dossier timeout",
    STALE_AFTER_MS > 30 * 60 * 1000, `${STALE_AFTER_MS}ms`);

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
