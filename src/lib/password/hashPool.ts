/**
 * Password hashing, moved off the main event loop.
 *
 * WHY THIS EXISTS. `bcryptjs` is the pure-JavaScript bcrypt, so at cost factor 12 it burns
 * ~200 ms of CPU **on the thread that serves every page, every API response and every
 * Socket.io frame** — measured on an M4: 197 ms per compare, during which a 10 ms timer
 * fired twice instead of twenty, i.e. the loop was available about 10 % of the time. The
 * production box has 2 vCPUs and runs ONE Node process with no clustering, so the second
 * core cannot absorb any of it.
 *
 * On 10 Oct 2026 a friendly attack on `POST /api/auth/login` used exactly this to take the
 * whole platform down — live games, clocks, dashboards. The rate limiter added that night
 * (`src/lib/http/rateLimit.ts`) CAPS the cost; this removes it, by doing the work in worker
 * threads where blocking is harmless.
 *
 * Three mechanics here are load-bearing. Changing any of them reintroduces a failure that is
 * hard to see:
 *
 *  1. **The worker is built from an inline SOURCE STRING, not a file path.** Next.js bundles
 *     server code, so a sibling `hashWorker.ts` is not guaranteed to exist as a loadable file
 *     in `.next/`'s output — and that would fail only in production, only on login. An eval'd
 *     worker runs in a CommonJS wrapper, so `require("bcryptjs")` resolves against the image's
 *     `node_modules`, which the Dockerfile keeps (it never prunes).
 *
 *  2. **Workers are `ref()`d while busy and `unref()`d while idle** — and it has to be both.
 *     `hashPassword` is also called from `scripts/createHeadUser.ts`, `setHeadPassword.ts`,
 *     `seedDemoAccounts.ts` and `verifyRoles.ts`: a permanently referenced worker keeps the
 *     event loop alive, so those scripts would hash correctly and then **hang forever instead
 *     of exiting**. But a permanently UNreferenced one is worse and much sneakier — a pending
 *     promise is not a reason for Node to stay alive, so with every handle unreferenced the
 *     loop empties and **the process exits in the middle of hashing a password**. That is
 *     exactly what the first run of `scripts/verifyHashPool.ts` did: exit code 0, half the
 *     output, no error.
 *
 *  3. **It falls back to in-process hashing.** If a worker cannot start or dies, we do the work
 *     on the main thread rather than failing the request: the worst case is then the behaviour
 *     of 9 Oct — which is now rate limited — rather than nobody being able to log in. The
 *     fallback logs loudly, because a silent degradation is exactly how the clobbered-`fetch`
 *     bug hid for weeks while every dossier quietly lost its AI narrative.
 *
 * Hashes are unchanged bcrypt — bcryptjs v3 emits the `$2b$` prefix — so nothing needs
 * migrating and no password breaks. `$2a$` and `$2b$` differ only in a long-fixed wraparound
 * bug and verify interchangeably, which matters because rows predating this are a mix.
 */
import { Worker } from "node:worker_threads";
import bcrypt from "bcryptjs";

/** Matches the 2 vCPUs in production. More workers than cores just adds context switching. */
const POOL_SIZE = 2;

/**
 * A job that has not answered in this long is treated as a dead worker.
 *
 * Generous on purpose: a cost-12 hash is ~200 ms on a fast machine and the production vCPU is
 * several times slower, so this must not fire for a merely slow box. It exists so a wedged
 * worker surfaces as a failed login rather than a request that hangs until the client gives up.
 */
const JOB_TIMEOUT_MS = 30_000;

export const BCRYPT_COST = 12;

type Job =
  | { op: "hash"; password: string; cost: number }
  | { op: "compare"; password: string; hash: string };

type Pending = {
  resolve: (value: string | boolean) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

/**
 * The worker body. Kept as a string for reason (1) above.
 *
 * Note it answers EVERY message, including on failure — a worker that stays silent on an
 * error would leak a pending promise per bad job until the timeout swept it.
 */
const WORKER_SOURCE = `
const { parentPort } = require("node:worker_threads");
const bcrypt = require("bcryptjs");

parentPort.on("message", (job) => {
  const done = (payload) => parentPort.postMessage(Object.assign({ id: job.id }, payload));

  const work = job.op === "hash"
    ? bcrypt.hash(job.password, job.cost)
    : bcrypt.compare(job.password, job.hash);

  Promise.resolve(work).then(
    (result) => done({ result }),
    (error) => done({ error: String((error && error.message) || error) }),
  );
});
`;

type PoolWorker = {
  worker: Worker;
  /** Jobs handed to this worker and not yet answered. Used to pick the least-loaded one. */
  pending: Map<number, Pending>;
};

/**
 * Hold the process open for exactly as long as a worker has work outstanding.
 *
 * Call `acquire` before registering a job and `release` after settling one. See reason (2) at
 * the top: permanently referenced hangs every seeding script, permanently unreferenced exits
 * mid-hash. The size check means nested jobs on one worker only ref once.
 */
function acquire(entry: PoolWorker) {
  if (entry.pending.size === 0) entry.worker.ref();
}

function release(entry: PoolWorker) {
  if (entry.pending.size === 0) entry.worker.unref();
}

let pool: PoolWorker[] | null = null;
/** Set once the pool is known to be unusable, so we stop retrying per request. */
let poolDisabled = false;
let nextJobId = 1;

function disablePool(reason: string, error?: unknown) {
  if (!poolDisabled) {
    poolDisabled = true;
    // Loud, once. This is a real degradation: hashing is back on the event loop and the box
    // is again vulnerable to the 10 Oct failure mode if the rate limiter is ever relaxed.
    console.error(
      `[hashPool] DEGRADED — hashing on the main event loop. Reason: ${reason}`,
      error ?? "",
    );
  }

  // Reject everything outstanding; the callers fall back below.
  for (const entry of pool ?? []) {
    for (const [, pending] of entry.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`hashPool unavailable: ${reason}`));
    }
    entry.pending.clear();
    void entry.worker.terminate();
  }

  pool = null;
}

function spawn(): PoolWorker {
  const worker = new Worker(WORKER_SOURCE, { eval: true });
  const entry: PoolWorker = { worker, pending: new Map() };

  worker.on("message", (message: { id: number; result?: string | boolean; error?: string }) => {
    const pending = entry.pending.get(message.id);
    if (!pending) return; // Already timed out; nothing to settle.

    entry.pending.delete(message.id);
    release(entry);
    clearTimeout(pending.timer);

    if (message.error !== undefined) {
      pending.reject(new Error(message.error));
    } else {
      pending.resolve(message.result as string | boolean);
    }
  });

  worker.on("error", (error) => disablePool("worker error", error));
  worker.on("exit", (code) => {
    // Code 0 after terminate() is our own shutdown; anything else is a crash.
    if (code !== 0 && !poolDisabled) disablePool(`worker exited with code ${code}`);
  });

  // Start idle. `acquire`/`release` reference it only while a job is outstanding.
  worker.unref();

  return entry;
}

function ensurePool(): PoolWorker[] | null {
  if (poolDisabled) return null;

  // An operational escape hatch. If the workers ever misbehave in production, setting this
  // and restarting puts hashing back on the main thread — slow and vulnerable, but working —
  // without needing a code change and a 15-minute rebuild on a 2-vCPU box. It is also how
  // `scripts/verifyHashPool.ts` exercises the fallback path for real rather than by mocking.
  if (process.env.KCA_DISABLE_HASH_POOL === "1") {
    disablePool("KCA_DISABLE_HASH_POOL=1");
    return null;
  }

  if (pool) return pool;

  try {
    pool = Array.from({ length: POOL_SIZE }, spawn);
    return pool;
  } catch (error) {
    disablePool("could not start workers", error);
    return null;
  }
}

function run(job: Job): Promise<string | boolean> {
  const workers = ensurePool();

  if (!workers || workers.length === 0) {
    return Promise.reject(new Error("hashPool unavailable"));
  }

  // Least-loaded rather than round-robin: bcryptjs inside a worker yields between rounds, so
  // two jobs on one worker interleave and both get slower. Spreading them keeps latency flat.
  const target = workers.reduce((a, b) => (a.pending.size <= b.pending.size ? a : b));
  const id = nextJobId++;

  return new Promise<string | boolean>((resolve, reject) => {
    const timer = setTimeout(() => {
      target.pending.delete(id);
      release(target);
      reject(new Error("hashPool job timed out"));
    }, JOB_TIMEOUT_MS);
    // The worker's own ref holds the process open; this timer must not do it as well, or a
    // 30 s handle would delay every script's exit by up to half a minute.
    timer.unref?.();

    acquire(target);
    target.pending.set(id, { resolve, reject, timer });
    target.worker.postMessage({ id, ...job });
  });
}

/** Hash a password. Falls back to the main thread if the pool is unavailable. */
export async function hashInPool(password: string): Promise<string> {
  try {
    return (await run({ op: "hash", password, cost: BCRYPT_COST })) as string;
  } catch (error) {
    if (!poolDisabled) console.error("[hashPool] hash fell back to the main thread:", error);
    return bcrypt.hash(password, BCRYPT_COST);
  }
}

/**
 * Verify a password. Falls back to the main thread if the pool is unavailable.
 *
 * A pool failure must never read as "wrong password" — that would lock everyone out of their
 * account during an unrelated outage — so the fallback re-does the comparison properly rather
 * than returning false.
 */
export async function compareInPool(password: string, passwordHash: string): Promise<boolean> {
  try {
    return (await run({ op: "compare", password, hash: passwordHash })) as boolean;
  } catch (error) {
    if (!poolDisabled) console.error("[hashPool] compare fell back to the main thread:", error);
    return bcrypt.compare(password, passwordHash);
  }
}

/** Whether hashing is currently happening off the event loop. For the verify script. */
export function hashPoolHealthy() {
  return !poolDisabled && pool !== null;
}

/**
 * Shut the pool down. Nothing in the app needs this — `unref()` already lets the process
 * exit — but a verify script that asserts the fallback path needs a way to tear down first.
 */
export async function shutdownHashPool() {
  const workers = pool ?? [];
  pool = null;
  await Promise.all(workers.map((entry) => entry.worker.terminate()));
}
