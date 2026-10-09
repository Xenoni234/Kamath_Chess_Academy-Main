/**
 * The login throttle holds, and a refresh token is unique per login.
 *
 *   npx tsx scripts/verifyLoginThrottle.ts     # offline: no server, no database, no network
 *
 * What this pins is the 10 Oct 2026 outage. A friendly attack on `POST /api/auth/login`
 * took the entire platform down: bcryptjs at cost 12 blocks the single Node event loop for
 * ~200 ms per attempt (10% loop availability, measured), and each successful login holds
 * three of the pool's ten database connections, so every other query in the app timed out
 * after 10 s. One unmetered route read as a total outage.
 *
 * Four properties below are each the difference between a limiter that works and one that
 * looks like it works:
 *
 *   1. SUCCESSFUL logins count against the per-address budget. The attack used VALID
 *      credentials. A limiter that only counts failures — the textbook design — would have
 *      let the whole thing through untouched.
 *   2. `clientIp` reads the LAST `X-Forwarded-For` hop. The leftmost entry is whatever the
 *      client sent, so keying on it lets an attacker mint a fresh bucket per request with
 *      one header. The older Redis limiters in this codebase take `[0]` and are bypassable
 *      that way.
 *   3. The key Map is BOUNDED and refuses rather than evicting. A limiter that grows a
 *      Map per attacker-chosen key is the memory exhaustion it is supposed to prevent, and
 *      one that evicts live windows lets a flood reset its own budget through eviction.
 *   4. Two refresh tokens signed in the SAME SECOND differ. Without a `jti` the signed
 *      payload is identical to the byte, `UserSession.refreshToken` is `@unique`, and the
 *      insert died with P2002 — which is what filled the production log. That one fires
 *      for a student double-clicking "Sign in", with no attacker involved.
 *
 * Time is driven by a stubbed `Date.now`, so windows expire deterministically and the run
 * takes milliseconds rather than twenty minutes.
 */
process.env.JWT_SECRET ??= "verify-only-access-secret-not-a-real-key";
process.env.JWT_REFRESH_SECRET ??= "verify-only-refresh-secret-not-a-real-key";

import {
  clearAll,
  clientIp,
  consume,
  exceeded,
  reset,
  trackedKeys,
} from "../src/lib/http/rateLimit.ts";
import { signRefreshToken, verifyRefreshToken } from "../src/lib/auth.ts";

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

// ---- deterministic clock -------------------------------------------------------------
const realNow = Date.now;
let clock = 1_760_000_000_000;
Date.now = () => clock;
const advance = (ms: number) => {
  clock += ms;
};

// Mirrors the constants in the login route.
const MAX_PER_IP = 30;
const IP_WINDOW_MS = 5 * 60_000;
const MAX_FAILURES_PER_ACCOUNT = 10;
const ACCOUNT_WINDOW_MS = 15 * 60_000;

const ipKey = (ip: string) => `login:ip:${ip}`;
const acctKey = (id: string) => `login:account:${id.toLowerCase()}`;

console.log("1. Per-address budget — the cap that ends the outage");
clearAll();
let blockedAt = 0;
for (let i = 1; i <= MAX_PER_IP + 5; i++) {
  if (consume(ipKey("1.2.3.4"), MAX_PER_IP, IP_WINDOW_MS).limited && blockedAt === 0) {
    blockedAt = i;
  }
}
check(`the first ${MAX_PER_IP} attempts are allowed`, blockedAt === MAX_PER_IP + 1, `blocked at ${blockedAt}`);
check(
  "a blocked caller gets a Retry-After of at most the window",
  exceeded(ipKey("1.2.3.4"), MAX_PER_IP).retryAfterSeconds <= IP_WINDOW_MS / 1000,
);
check(
  "a different address has its own budget",
  !consume(ipKey("9.9.9.9"), MAX_PER_IP, IP_WINDOW_MS).limited,
);

console.log("2. SUCCESS still costs budget — the attack used valid credentials");
clearAll();
// Simulate what the route does on a correct password: consume the IP budget, reset only
// the account key. Thirty valid logins must still exhaust the address budget.
for (let i = 0; i < MAX_PER_IP; i++) {
  consume(ipKey("5.5.5.5"), MAX_PER_IP, IP_WINDOW_MS);
  reset(acctKey("victim"));
}
check(
  "30 SUCCESSFUL logins exhaust the per-address budget",
  consume(ipKey("5.5.5.5"), MAX_PER_IP, IP_WINDOW_MS).limited,
);
check(
  "clearing the account budget does not refund the address budget",
  exceeded(ipKey("5.5.5.5"), MAX_PER_IP).limited,
);

console.log("3. Per-account budget counts failures only, and a success clears it");
clearAll();
check("a fresh account is not limited", !exceeded(acctKey("ravi"), MAX_FAILURES_PER_ACCOUNT).limited);
for (let i = 0; i < MAX_FAILURES_PER_ACCOUNT; i++) {
  consume(acctKey("ravi"), MAX_FAILURES_PER_ACCOUNT, ACCOUNT_WINDOW_MS);
}
check(
  `${MAX_FAILURES_PER_ACCOUNT} failures are allowed, the next is refused`,
  exceeded(acctKey("ravi"), MAX_FAILURES_PER_ACCOUNT).limited,
);
check(
  "the same account is limited regardless of letter case",
  exceeded(acctKey("RAVI"), MAX_FAILURES_PER_ACCOUNT).limited,
);
check(
  "a guessing run against one account does not limit a different one",
  !exceeded(acctKey("someone-else"), MAX_FAILURES_PER_ACCOUNT).limited,
);
// Four mistypes then the right password: the student must start clean.
clearAll();
for (let i = 0; i < 4; i++) consume(acctKey("ravi"), MAX_FAILURES_PER_ACCOUNT, ACCOUNT_WINDOW_MS);
reset(acctKey("ravi"));
check("a correct password clears the failure counter", !exceeded(acctKey("ravi"), MAX_FAILURES_PER_ACCOUNT).limited);

console.log("4. `exceeded` inspects without charging");
clearAll();
for (let i = 0; i < 50; i++) exceeded(acctKey("ghost"), MAX_FAILURES_PER_ACCOUNT);
check("50 checks created no window", trackedKeys() === 0, `tracked ${trackedKeys()}`);

console.log("5. Windows expire");
clearAll();
for (let i = 0; i < MAX_PER_IP + 1; i++) consume(ipKey("7.7.7.7"), MAX_PER_IP, IP_WINDOW_MS);
check("limited before the window rolls over", exceeded(ipKey("7.7.7.7"), MAX_PER_IP).limited);
advance(IP_WINDOW_MS + 1000);
check("allowed again after it rolls over", !consume(ipKey("7.7.7.7"), MAX_PER_IP, IP_WINDOW_MS).limited);

console.log("6. X-Forwarded-For: the LAST hop wins, so the key cannot be forged");
const forged = new Request("https://kamathchessacademy.com/api/auth/login", {
  // What an attacker sends, plus what Caddy appends. Reading [0] hands them the bucket.
  headers: { "x-forwarded-for": "203.0.113.9, 198.51.100.7" },
});
check("the real peer is the rightmost entry", clientIp(forged) === "198.51.100.7", clientIp(forged));
check(
  "the client-supplied value is NOT used as the key",
  clientIp(forged) !== "203.0.113.9",
);
const single = new Request("https://kamathchessacademy.com/api/auth/login", {
  headers: { "x-forwarded-for": "198.51.100.7" },
});
check("a single hop is read as-is", clientIp(single) === "198.51.100.7", clientIp(single));
const none = new Request("https://kamathchessacademy.com/api/auth/login");
check(
  "a request that bypassed the proxy shares one bucket, never unlimited",
  clientIp(none) === "direct",
  clientIp(none),
);
// The forgery that actually matters: a fresh header value per request must NOT yield a
// fresh budget, because Caddy's appended hop is constant.
clearAll();
let escaped = false;
for (let i = 0; i < MAX_PER_IP + 10; i++) {
  const req = new Request("https://kamathchessacademy.com/api/auth/login", {
    headers: { "x-forwarded-for": `10.0.0.${i}, 198.51.100.7` },
  });
  const outcome = consume(ipKey(clientIp(req)), MAX_PER_IP, IP_WINDOW_MS);
  if (i >= MAX_PER_IP && !outcome.limited) escaped = true;
}
check("rotating the forged hop does not escape the limit", !escaped);

console.log("7. The limiter's own memory is bounded, and a flood cannot launder itself");
clearAll();
// Establish one exhausted bucket FIRST — this is the attacker's own window.
for (let i = 0; i < MAX_PER_IP + 1; i++) consume(ipKey("198.51.100.7"), MAX_PER_IP, IP_WINDOW_MS);
check("the attacker's window starts out exhausted", exceeded(ipKey("198.51.100.7"), MAX_PER_IP).limited);

// Now 25k distinct keys, past the 20k ceiling. It must refuse rather than grow, and it
// must NOT evict the exhausted window above — eviction would reset the attacker's budget.
let refusedSomething = false;
for (let i = 0; i < 25_000; i++) {
  if (consume(`login:ip:10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`, MAX_PER_IP, IP_WINDOW_MS).limited) {
    refusedSomething = true;
  }
}
check("tracked keys stay at or below the 20k ceiling", trackedKeys() <= 20_000, `tracked ${trackedKeys()}`);
check("keys past the ceiling are refused rather than admitted", refusedSomething);
check(
  "flooding 25k new keys did NOT evict the exhausted window",
  exceeded(ipKey("198.51.100.7"), MAX_PER_IP).limited,
);

console.log("8. A refresh token is unique per login — the P2002 that filled the log");
const payload = { userId: "usr_abc123", username: "ravi", role: "STUDENT" as const };
// Same account, same second: this is the exact case that collided on the unique index.
Date.now = realNow;
const a = signRefreshToken(payload);
const b = signRefreshToken(payload);
check("two tokens signed in the same second differ", a !== b);
const decodedA = verifyRefreshToken(a);
const decodedB = verifyRefreshToken(b);
check("both still verify", decodedA.userId === "usr_abc123" && decodedB.userId === "usr_abc123");
check("each carries a distinct jti", Boolean(decodedA.jti) && decodedA.jti !== decodedB.jti, String(decodedA.jti));
check("the issued-at second really is identical", decodedA.iat === decodedB.iat, `${decodedA.iat} vs ${decodedB.iat}`);
// 200 logins in a burst, all unique — the session table can finally tell devices apart.
const many = new Set(Array.from({ length: 200 }, () => signRefreshToken(payload)));
check("200 tokens in a burst are all distinct", many.size === 200, `got ${many.size}`);

console.log(`\n${fail === 0 ? "✅ ALL PASS" : `❌ ${fail} FAILED`} (${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);
