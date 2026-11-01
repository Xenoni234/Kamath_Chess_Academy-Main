import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { verifyAccessToken } from "@/lib/auth";
import { hasRole } from "@/lib/authz";
import WebsiteContentClient from "./WebsiteContentClient";

/**
 * HEAD only — the "Our Champions" strip and the coaching team on the public site.
 *
 * This guard exists because the page itself is a client component and therefore could not
 * carry one: `hasRole` runs on the server. Without this wrapper the page's only protection
 * was `proxy.ts`, which is a single edge check — and `AGENTS.md` is explicit that role access
 * is enforced in four places deliberately, so that a proxy misconfiguration is never the only
 * thing in the way. That mattered more than usual here: Next.js 16.2.9 shipped a *critical*
 * middleware/proxy bypass (patched in the 16.4.3 bump), and this page was one of exactly two
 * under `/dashboard/admin` relying on that layer alone.
 *
 * HEAD and not HR, to match `requireRole(payload, ["HEAD"])` in `/api/admin/site`. `proxy.ts`
 * allows HR into `/dashboard/admin/*`, so before this an HR user could open this page and
 * watch every request on it fail — the page gated more loosely than the API behind it.
 * `proxy.ts` now carries a narrower entry for this path too, the same way
 * `/dashboard/admin/payments` already did.
 */
export default async function WebsiteContentPage() {
  const token = (await cookies()).get("kca_access_token")?.value ?? "";

  let role = "";
  try {
    role = verifyAccessToken(token).role;
  } catch {
    redirect("/login");
  }

  if (!hasRole(role as never, ["HEAD"])) redirect(`/dashboard/${role.toLowerCase()}`);

  return <WebsiteContentClient />;
}
