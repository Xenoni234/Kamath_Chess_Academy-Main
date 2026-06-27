import { cookies } from "next/headers";
import DashboardCards from "@/components/dashboard/DashboardCards";
import DashboardHeader from "@/components/dashboard/DashboardHeader";
import { verifyAccessToken } from "@/lib/auth";

export default async function ParentDashboardPage() {
  const token = (await cookies()).get("kca_access_token")?.value ?? "";
  const payload = verifyAccessToken(token);

  return (
    <>
      <DashboardHeader title="Parent Dashboard" username={payload.username} />
      <DashboardCards cards={["Child's Progress", "Upcoming Classes", "Payment History", "Reports"]} />
    </>
  );
}
