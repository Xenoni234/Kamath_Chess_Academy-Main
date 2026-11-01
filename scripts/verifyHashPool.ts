/**
 * Password hashing happens OFF the main event loop, and still produces the same hashes.
 *
 *   npx tsx scripts/verifyHashPool.ts                         # pool mode
 *   KCA_DISABLE_HASH_POOL=1 npx tsx scripts/verifyHashPool.ts # fallback mode
 *
 * Offline: no server, no database, no network. Run it BOTH ways — the fallback is a real
 * production code path (the operational escape hatch), not a hypothetical.
 *
 * What this pins is the 10 Oct 2026 outage. `bcryptjs` is pure JavaScript, so a cost-12
 * compare burns ~200 ms on whichever thread runs it. On the main thread that is the thread
 * serving every page, every API response and every Socket.io frame — measured before the fix:
 * during a 199 ms compare a 10 ms timer fired TWICE instead of twenty, so the loop was
 * available about 10 % of the time. An unmetered login route turned that into a total
 * platform outage at single-digit requests per second.
 *
 * Check 1 is therefore the whole point: the event loop must stay responsive while a password
 * is being hashed. If someone "simplifies" `src/lib/auth.ts` back to calling bcryptjs
 * directly, that check fails and nothing else here does.
 *
 * NOTE ON HOW THIS SCRIPT ENDS. It sets `process.exitCode` and returns — it deliberately does
 * NOT call `process.exit()`, and deliberately does not shut the pool down. A worker thread
 * that is not `unref()`d keeps the event loop alive, so this script HANGING is itself a
 * failure: it is what would happen to `scripts/createHeadUser.ts`, `setHeadPassword.ts`,
 * `seedDemoAccounts.ts` and `verifyRoles.ts`, all of which hash a password and must exit.
 * Run it under `timeout` in CI so the hang is reported rather than waited on.
 */
import bcrypt from "bcryptjs";
import { hashPassword, comparePassword } from "../src/lib/auth.ts";
import { BCRYPT_COST, hashPoolHealthy } from "../src/lib/password/hashPool.ts";

const FALLBACK_MODE = process.env.KCA_DISABLE_HASH_POOL === "1";

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

/** Run `work`, reporting how much of the wall time the event loop was able to service a timer. */
async function loopAvailabilityDuring(work: () => Promise<unknown>) {
  const TICK_MS = 10;
  let ticks = 0;
  const timer = setInterval(() => ticks++, TICK_MS);
  const started = performance.now();
  await work();
  const elapsed = performance.now() - started;
  clearInterval(timer);

  const ideal = Math.max(1, Math.round(elapsed / TICK_MS));
  return { elapsed, ticks, ideal, availability: ticks / ideal };
}

/**
 * Wrapped in a function because tsx compiles these scripts as CommonJS (there is no
 * `"type": "module"` in package.json), so top-level `await` is not available here.
 */
async function main() {
  const PASSWORD = "a-perfectly-ordinary-student-password";

  console.log(`mode: ${FALLBACK_MODE ? "FALLBACK (main thread)" : "POOL (worker threads)"}\n`);

  // Warm first, for two reasons: the very first call pays for worker startup, which would
  // muddy the timing measurement, and the pool is created LAZILY so `hashPoolHealthy()` is
  // false until something has actually been hashed. Asserting the mode before this would
  // report "unhealthy" for a perfectly good pool.
  await hashPassword(PASSWORD);
  const hashed = await hashPassword(PASSWORD);

  console.log("0. The pool reports the mode it is actually in");
  check(
    FALLBACK_MODE ? "pool is disabled, as asked" : "pool is healthy",
    hashPoolHealthy() === !FALLBACK_MODE,
    `hashPoolHealthy()=${hashPoolHealthy()}`,
  );

  console.log("1. The event loop survives a password hash — the reason this module exists");

  const during = await loopAvailabilityDuring(() => comparePassword(PASSWORD, hashed));
  console.log(
    `      compare took ${during.elapsed.toFixed(0)} ms; 10 ms timer fired ${during.ticks}x ` +
      `(ideal ${during.ideal}) => loop available ${(during.availability * 100).toFixed(0)}%`,
  );

  if (FALLBACK_MODE) {
    // Documenting the thing we are escaping from: on the main thread the loop starves. Asserting
    // it here means the measurement itself is trustworthy — if this ever reported HIGH
    // availability on the main thread, check 1's pass in pool mode would prove nothing.
    check(
      "on the main thread the loop starves, as originally measured",
      during.availability < 0.5,
      `${(during.availability * 100).toFixed(0)}% — expected well under 50%`,
    );
  } else {
    check(
      "the loop stays responsive while hashing (>=70% of ticks land)",
      during.availability >= 0.7,
      `${(during.availability * 100).toFixed(0)}% — hashing is back on the main thread`,
    );
    check(
      "and it is genuinely doing the work, not short-circuiting",
      during.elapsed > 20,
      `${during.elapsed.toFixed(0)} ms is too fast to be a real cost-12 compare`,
    );
  }

  console.log("2. Hashing is still correct");
  check("the right password verifies", await comparePassword(PASSWORD, hashed));
  check("a wrong password does not", !(await comparePassword(PASSWORD + "x", hashed)));
  check("an empty password does not", !(await comparePassword("", hashed)));
  check("two hashes of one password differ (salted)", (await hashPassword(PASSWORD)) !== hashed);

  console.log("3. Existing stored hashes still work — nobody's password breaks");
  // Produced the old way, in-process, exactly as every row in the database was.
  const legacy = await bcrypt.hash(PASSWORD, BCRYPT_COST);
  check("a hash made by in-process bcryptjs verifies through this path", await comparePassword(PASSWORD, legacy));
  check("the format is unchanged bcrypt", /^\$2[aby]\$\d{2}\$/.test(hashed), hashed.slice(0, 7));
  // bcryptjs v3 emits `$2b$`; older rows may be `$2a$`. The prefixes differ only in a
  // long-fixed wraparound bug and verify interchangeably, so accept either and pin the COST,
  // which is the part that must not quietly drop.
  check(
    `the cost factor is still ${BCRYPT_COST}`,
    new RegExp(`^\\$2[aby]\\$${BCRYPT_COST}\\$`).test(hashed),
    hashed.slice(0, 7),
  );
  // And the reverse direction: a hash made here must be readable by plain bcryptjs, or a
  // rollback to the old code would lock out everyone who changed their password meanwhile.
  check("a hash made here verifies under plain bcryptjs", await bcrypt.compare(PASSWORD, hashed));

  console.log("4. Concurrency — the login route can be hit by several people at once");
  const many = await Promise.all(
    Array.from({ length: 6 }, (_, i) => comparePassword(i === 3 ? PASSWORD : "wrong", hashed)),
  );
  check("six concurrent compares each return the right answer", JSON.stringify(many) === JSON.stringify([false, false, false, true, false, false]), JSON.stringify(many));

  console.log("5. A malformed stored hash is a false, not a crash");
  // A truncated or garbage hash must not take the login route to a 500.
  let threw = false;
  let result: boolean | null = null;
  try {
    result = await comparePassword(PASSWORD, "$2a$12$not-a-real-hash");
  } catch {
    threw = true;
  }
  check("comparing against a garbage hash does not throw", !threw);
  check("and it reports false", result === false, String(result));

  console.log(`\n${fail === 0 ? "✅ ALL PASS" : `❌ ${fail} FAILED`} (${pass} passed)`);
  console.log(
    FALLBACK_MODE
      ? "(fallback mode — hashing on the main thread, as the escape hatch intends)"
      : "(pool mode — if this script does not now EXIT, a worker is not unref()'d)",
  );

  // No process.exit(), no shutdown: see the note at the top. Exiting cleanly IS a check.
  process.exitCode = fail === 0 ? 0 : 1;
}

// Not awaited with a .then(process.exit) — see the note at the top: exiting naturally is
// itself the unref() check.
void main();
