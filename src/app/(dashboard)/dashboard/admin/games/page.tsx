import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { verifyAccessToken } from "@/lib/auth";
import { hasRole } from "@/lib/authz";
import AdminGamesClient from "./AdminGamesClient";

/**
 * HR/HEAD only — what the Head dashboard's "Games Played" number is counting.
 *
 * Same reasoning as the website page next door: the view is a client component, so it could
 * not hold a `hasRole` check of its own, and until now `proxy.ts` was the only thing standing
 * in front of it. `AGENTS.md` requires four independent layers precisely so one bypass is not
 * enough — and Next.js 16.2.9 had a *critical* middleware/proxy bypass, patched in the 16.4.3
 * bump that landed alongside this.
 *
 * `["HEAD", "HR"]` matches `requireRole(payload, ["HEAD", "HR"])` in `/api/admin/games`. The
 * guard and the API it calls must agree: looser here and a user reaches a page that cannot
 * work, tighter and staff are refused a page they are entitled to.
 *
 * This lists every game on the platform, including both players' usernames, so it is academy
 * data rather than one student's — which is why it stops at staff and is not widened to
 * coaches via `canViewStudent`.
 */
export default async function AdminGamesPage() {
  const token = (await cookies()).get("kca_access_token")?.value ?? "";

  let role = "";
  try {
    role = verifyAccessToken(token).role;
  } catch {
    redirect("/login");
  }

  if (!hasRole(role as never, ["HEAD", "HR"])) redirect(`/dashboard/${role.toLowerCase()}`);

  return <AdminGamesClient />;
}
