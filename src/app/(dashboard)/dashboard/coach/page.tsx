import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import DashboardCards from "@/components/dashboard/DashboardCards";
import DashboardHeader from "@/components/dashboard/DashboardHeader";
import { verifyAccessToken } from "@/lib/auth";
import { hasRole } from "@/lib/authz";
import { getCoachCards } from "@/lib/dashboard";

export default async function CoachDashboardPage() {
  const token = (await cookies()).get("kca_access_token")?.value ?? "";
  let payload;
  try {
    payload = verifyAccessToken(token);
  } catch {
    redirect("/login");
  }

  // Defence in depth. `proxy.ts` already routes by role, but that is one edge
  // check away from being the only thing between a student and this page — if its
  // matcher is ever edited, the page itself must still refuse.
  if (!hasRole(payload.role, ["COACH"])) {
    redirect(`/dashboard/${payload.role.toLowerCase()}`);
  }
  const cards = await getCoachCards(payload.userId);

  return (
    <>
      <DashboardHeader title="Coach Dashboard" username={payload.username} />
      <DashboardCards cards={cards} />
    </>
  );
}
