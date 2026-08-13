import { cookies } from "next/headers";
import DashboardCards from "@/components/dashboard/DashboardCards";
import DashboardHeader from "@/components/dashboard/DashboardHeader";
import { verifyAccessToken } from "@/lib/auth";
import { getStudentCards } from "@/lib/dashboard";

export default async function StudentDashboardPage() {
  const token = (await cookies()).get("kca_access_token")?.value ?? "";
  const payload = verifyAccessToken(token);
  const cards = await getStudentCards(payload.userId);

  return (
    <>
      <DashboardHeader title="Student Dashboard" username={payload.username} />
      <DashboardCards cards={cards} />
    </>
  );
}
