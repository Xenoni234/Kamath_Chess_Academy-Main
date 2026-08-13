import { cookies } from "next/headers";
import DashboardCards from "@/components/dashboard/DashboardCards";
import DashboardHeader from "@/components/dashboard/DashboardHeader";
import { verifyAccessToken } from "@/lib/auth";
import { getCoachCards } from "@/lib/dashboard";

export default async function CoachDashboardPage() {
  const token = (await cookies()).get("kca_access_token")?.value ?? "";
  const payload = verifyAccessToken(token);
  const cards = await getCoachCards(payload.userId);

  return (
    <>
      <DashboardHeader title="Coach Dashboard" username={payload.username} />
      <DashboardCards cards={cards} />
    </>
  );
}
