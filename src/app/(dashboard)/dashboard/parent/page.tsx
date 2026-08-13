import { cookies } from "next/headers";
import DashboardCards from "@/components/dashboard/DashboardCards";
import DashboardHeader from "@/components/dashboard/DashboardHeader";
import { verifyAccessToken } from "@/lib/auth";
import { getParentCards } from "@/lib/dashboard";

export default async function ParentDashboardPage() {
  const token = (await cookies()).get("kca_access_token")?.value ?? "";
  const payload = verifyAccessToken(token);
  const cards = await getParentCards(payload.userId);

  return (
    <>
      <DashboardHeader title="Parent Dashboard" username={payload.username} />
      <DashboardCards cards={cards} />
    </>
  );
}
