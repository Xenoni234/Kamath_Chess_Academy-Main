/**
 * Every role-gated dashboard page refuses the wrong roles — at the PAGE, not just the proxy.
 *
 *   npm run dev                                                   # in another terminal
 *   npx tsx --env-file=.env.local scripts/verifyRolePages.ts
 *
 * Needs a running server. Needs NO database: it mints its own access tokens with the real
 * `JWT_SECRET` and asserts on the redirect, which every guard decides before touching Prisma.
 * That matters right now, because it means this still runs while the database is down.
 *
 * WHY THIS EXISTS. `AGENTS.md` requires role access to be enforced in four independent places,
 * so that a misconfigured proxy is never the only thing between a student and academy revenue.
 * Two pages under `/dashboard/admin` were relying on `proxy.ts` alone — `website` and `games`
 * — because both are client components and `hasRole` is a server-side check. Next.js 16.2.9
 * then turned out to ship a **critical middleware/proxy bypass** (CVE patched in 16.4.3), which
 * is precisely the single layer those two were trusting.
 *
 * It also pins a mismatch that is easy to reintroduce: a page must gate **exactly as tightly
 * as the API it calls**. `/api/admin/site` is HEAD-only, while `proxy.ts` lets HR anywhere
 * under `/dashboard/admin` — so an HR user used to reach the website editor and watch every
 * request on it fail, which reads as a broken feature rather than a refusal.
 *
 * A 307 to another dashboard is a REFUSAL. A 200 is access. Anything else is a bug worth
 * looking at, which is why the unexpected status is printed rather than swallowed.
 */
import { signAccessToken } from "../src/lib/auth.ts";

const BASE = process.env.KCA_BASE_URL ?? "http://localhost:3000";

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

type Role = "STUDENT" | "PARENT" | "COACH" | "HR" | "HEAD";

function tokenFor(role: Role) {
  // A real, correctly signed token — the point is to test authorisation, not authentication.
  // The user id never has to exist: every guard checks the role on the token and redirects
  // before any query runs.
  return signAccessToken({ userId: `usr_verify_${role.toLowerCase()}`, username: `verify_${role.toLowerCase()}`, role });
}

async function visit(path: string, role: Role | null) {
  const headers: Record<string, string> = {};
  if (role) headers.cookie = `kca_access_token=${tokenFor(role)}`;
  const res = await fetch(`${BASE}${path}`, { headers, redirect: "manual" });
  return { status: res.status, location: res.headers.get("location") };
}

/** Who each page must let in. Mirrors the `requireRole` on the API each page calls. */
const MATRIX: Array<{ path: string; allowed: Role[]; api: string }> = [
  { path: "/dashboard/admin/website", allowed: ["HEAD"], api: "/api/admin/site → HEAD" },
  { path: "/dashboard/admin/games", allowed: ["HEAD", "HR"], api: "/api/admin/games → HEAD, HR" },
  { path: "/dashboard/admin/users", allowed: ["HEAD", "HR"], api: "/api/admin/users → HEAD, HR" },
  { path: "/dashboard/admin/payments", allowed: ["HEAD"], api: "/api/payments → HEAD" },
  { path: "/dashboard/admin/audit", allowed: ["HEAD"], api: "/api/admin/audit → HEAD" },
  { path: "/dashboard/head", allowed: ["HEAD"], api: "head dashboard" },
  { path: "/dashboard/hr", allowed: ["HR", "HEAD"], api: "hr dashboard" },
];

const ALL_ROLES: Role[] = ["STUDENT", "PARENT", "COACH", "HR", "HEAD"];

async function main() {
  try {
    await fetch(BASE, { redirect: "manual" });
  } catch {
    console.error(`Cannot reach ${BASE}. Start the dev server first: npm run dev`);
    process.exit(1);
  }

  console.log("1. Signed-out visitors never reach a dashboard page");
  for (const { path } of MATRIX) {
    const r = await visit(path, null);
    check(
      `${path} redirects an anonymous visitor to /login`,
      r.status === 307 && (r.location ?? "").startsWith("/login"),
      `got ${r.status} -> ${r.location}`,
    );
  }

  console.log("\n2. Each page admits exactly the roles its API admits");
  for (const { path, allowed, api } of MATRIX) {
    console.log(`   ${path}  (${api})`);
    for (const role of ALL_ROLES) {
      const r = await visit(path, role);
      const admitted = r.status === 200;
      const shouldAdmit = allowed.includes(role);
      check(
        `     ${role.padEnd(7)} ${shouldAdmit ? "admitted" : "refused "}`,
        admitted === shouldAdmit,
        `got ${r.status}${r.location ? ` -> ${r.location}` : ""}`,
      );
    }
  }

  console.log(`\n${fail === 0 ? "✅ ALL PASS" : `❌ ${fail} FAILED`} (${pass} passed)`);
  process.exit(fail === 0 ? 0 : 1);
}

void main();
