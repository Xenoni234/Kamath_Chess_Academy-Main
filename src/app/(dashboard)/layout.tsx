import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import DashboardSidebar from "@/components/dashboard/DashboardSidebar";
import { verifyAccessToken } from "@/lib/auth";
import type { TokenPayload } from "@/lib/auth";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const cookieStore = await cookies();
  const token = cookieStore.get("kca_access_token")?.value;

  if (!token) {
    redirect("/login");
  }

  let payload: TokenPayload;

  try {
    payload = verifyAccessToken(token);
  } catch {
    redirect("/login");
  }

  return (
    <div className="min-h-screen bg-kca-black text-kca-white md:flex">
      <DashboardSidebar username={payload.username} role={payload.role} />
      <main className="min-w-0 flex-1 px-6 py-8 md:px-8 lg:px-10">{children}</main>
    </div>
  );
}
