import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import DashboardSidebar from "@/components/dashboard/DashboardSidebar";
import SessionKeepAlive from "@/components/dashboard/SessionKeepAlive";
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
    /*
      App-shell layout from `md` up: the shell is exactly one viewport tall and
      does not scroll, so the sidebar physically cannot move. Only <main> is a
      scroll container.

      This replaces an attempt at `position: sticky` on the sidebar, which kept
      scrolling away regardless of `self-start`/`top-0`. Owning the scroll
      container is unconditional — there is no ancestor that can quietly break
      it later.

      Below `md` the shell stays in normal flow and the window scrolls as before.
    */
    <div className="min-h-screen bg-kca-black text-kca-white md:flex md:h-screen md:overflow-hidden">
      <SessionKeepAlive />
      <DashboardSidebar username={payload.username} role={payload.role} />
      <main className="min-w-0 flex-1 px-6 py-8 md:h-screen md:overflow-y-auto md:px-8 lg:px-10">
        {children}
      </main>
    </div>
  );
}
