/**
 * In-process rate limiting for routes whose cost is CPU rather than I/O.
 *
 * WHY THIS IS NOT THE REDIS PATTERN USED ELSEWHERE. `/api/contact`,
 * `/api/analysis/explain` and friends limit with `redis.incr`, and that is right for them:
 * what they are protecting is a quota or an inbox, the limits are per hour, and a Redis
 * round trip is noise next to the work being guarded.
 *
 * Login is the opposite case on every count. What it protects is THIS PROCESS'S EVENT
 * LOOP, so the guard has to be cheaper than the thing it guards — and a network call to
 * Upstash is not, especially once the loop is already saturated and the guard's own
 * request is queued behind the flood it exists to stop. A Redis limiter also has to decide
 * what to do when Redis is unreachable, and both answers are bad: fail open and the
 * protection evaporates exactly when the system is under stress, fail closed and a cache
 * blip locks every student out of their account. A synchronous in-memory check has no
 * failure mode, costs a Map lookup, and rejects in microseconds.
 *
 * The app runs as a SINGLE Node process (`server.mjs`, no clustering), so in-memory is
 * also exact rather than approximate. If this is ever clustered or run as more than one
 * container, each instance gets its own budget and the effective limit multiplies by the
 * instance count — at which point this needs to move to Redis with the failure-mode
 * question answered deliberately.
 *
 * State is bounded on purpose; see `MAX_TRACKED_KEYS`. A limiter that grows a Map per
 * distinct attacker-chosen key is itself a memory-exhaustion bug.
 */

/** One fixed window per key. */
type Window = {
  count: number;
  /** Epoch ms at which this window expires and the count resets. */
  resetAt: number;
};

const windows = new Map<string, Window>();

/**
 * Hard ceiling on distinct live keys.
 *
 * Without it, an attacker who varies the key (a rotating source address, a different
 * username per request) makes this Map the leak. 20k live keys is far beyond anything
 * this academy produces — it already IS the attack — so past that point new keys are
 * REFUSED rather than admitted by evicting a live window, which would otherwise let a
 * flood launder itself through eviction and reset its own budget.
 */
const MAX_TRACKED_KEYS = 20_000;

/** Drop expired windows. Amortised: only walks the Map when it has grown. */
function sweep(now: number) {
  for (const [key, window] of windows) {
    if (window.resetAt <= now) {
      windows.delete(key);
    }
  }
}

export type RateLimitResult = {
  /** True when the caller is over budget and must be refused. */
  limited: boolean;
  /** Seconds until the window resets, for a `Retry-After` header. Always >= 1. */
  retryAfterSeconds: number;
};

const ALLOWED: RateLimitResult = { limited: false, retryAfterSeconds: 0 };

/**
 * Count one event against `key` and report whether it is over `limit` within `windowMs`.
 *
 * The event is counted even when the result is `limited`, so a caller that keeps hammering
 * keeps the window alive rather than slipping through the moment it rolls over.
 */
export function consume(key: string, limit: number, windowMs: number): RateLimitResult {
  const now = Date.now();
  const existing = windows.get(key);

  if (existing && existing.resetAt > now) {
    existing.count += 1;
    if (existing.count > limit) {
      return {
        limited: true,
        retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
      };
    }
    return ALLOWED;
  }

  // New or expired window. Keep the Map bounded before inserting.
  if (!existing && windows.size >= MAX_TRACKED_KEYS) {
    sweep(now);
    if (windows.size >= MAX_TRACKED_KEYS) {
      // Refuse rather than evict. See MAX_TRACKED_KEYS.
      return { limited: true, retryAfterSeconds: Math.ceil(windowMs / 1000) };
    }
  }

  windows.set(key, { count: 1, resetAt: now + windowMs });
  return ALLOWED;
}

/**
 * Whether `key` has already SPENT its budget of `limit`, without counting a new event.
 *
 * This is what a failure-only budget needs: the check has to happen before the work, but
 * the charge only lands if the work fails. Using `consume` for both would charge every
 * attempt and turn a failure budget into an attempt budget.
 *
 * Note `>=`, not `>`. This is asked at the START of an attempt, so the question is "is
 * there budget left for this one" — and at `count === limit` there is not. `consume`
 * compares with `>` because it asks afterwards, having already counted. Getting these two
 * the same way round allowed an eleventh attempt on a budget of ten; the verify script
 * caught it.
 */
export function exceeded(key: string, limit: number): RateLimitResult {
  const now = Date.now();
  const window = windows.get(key);

  if (!window || window.resetAt <= now || window.count < limit) {
    return ALLOWED;
  }

  return {
    limited: true,
    retryAfterSeconds: Math.max(1, Math.ceil((window.resetAt - now) / 1000)),
  };
}

/** Forget a key's window — used to clear a failure counter after a success. */
export function reset(key: string) {
  windows.delete(key);
}

/** Current live key count. Exported for the verify script, not for route code. */
export function trackedKeys() {
  return windows.size;
}

/** Test seam: drop all state. Not used by route code. */
export function clearAll() {
  windows.clear();
}

/**
 * The client's address, as seen by OUR proxy — not as claimed by the client.
 *
 * `X-Forwarded-For` is a list that each hop APPENDS to, so the leftmost entry is whatever
 * the client sent and the rightmost is what the nearest trusted proxy observed. Caddy is
 * the only ingress (the app publishes no ports, only `expose`), so the last element is the
 * real peer and everything before it is attacker-controlled text.
 *
 * Taking `[0]`, which is the obvious-looking choice and what the older limiters in this
 * codebase do, hands the attacker the bucket key: one random header value per request and
 * every request lands in a fresh window, so the limit never triggers. Read the LAST hop.
 */
export function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");

  if (forwarded) {
    const hops = forwarded
      .split(",")
      .map((hop) => hop.trim())
      .filter(Boolean);

    if (hops.length > 0) {
      return hops[hops.length - 1];
    }
  }

  // Caddy always sets X-Forwarded-For, so this is the direct-connection case: a request
  // that reached the app without passing the proxy. Treat every such request as one
  // shared bucket rather than as unlimited.
  return "direct";
}
