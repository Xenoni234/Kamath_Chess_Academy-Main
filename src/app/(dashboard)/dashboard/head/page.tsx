import { cookies } from "next/headers";
import DashboardCards from "@/components/dashboard/DashboardCards";
import DashboardHeader from "@/components/dashboard/DashboardHeader";
import { verifyAccessToken } from "@/lib/auth";
import { getHeadCards } from "@/lib/dashboard";

export default async function HeadDashboardPage() {
  const token = (await cookies()).get("kca_access_token")?.value ?? "";
  const payload = verifyAccessToken(token);
  const cards = await getHeadCards();

  return (
    <>
      <DashboardHeader title="Head Dashboard" username={payload.username} />
      <DashboardCards cards={cards} />
    </>
  );
}
