import { cookies } from "next/headers";
import DashboardCards from "@/components/dashboard/DashboardCards";
import DashboardHeader from "@/components/dashboard/DashboardHeader";
import { verifyAccessToken } from "@/lib/auth";

export default async function CoachDashboardPage() {
  const token = (await cookies()).get("kca_access_token")?.value ?? "";
  const payload = verifyAccessToken(token);

  return (
    <>
      <DashboardHeader title="Coach Dashboard" username={payload.username} />
      <DashboardCards cards={["My Batches", "Upcoming Classes", "Student Progress", "Analysis Board"]} />
    </>
  );
}
