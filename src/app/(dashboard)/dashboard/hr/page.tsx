import { cookies } from "next/headers";
import DashboardCards from "@/components/dashboard/DashboardCards";
import DashboardHeader from "@/components/dashboard/DashboardHeader";
import { verifyAccessToken } from "@/lib/auth";
import { getHrCards } from "@/lib/dashboard";

export default async function HrDashboardPage() {
  const token = (await cookies()).get("kca_access_token")?.value ?? "";
  const payload = verifyAccessToken(token);
  const cards = await getHrCards();

  return (
    <>
      <DashboardHeader title="HR Dashboard" username={payload.username} />
      <DashboardCards cards={cards} />
    </>
  );
}
