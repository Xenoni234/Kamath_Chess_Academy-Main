import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { verifyAccessToken } from "@/lib/auth";
import ScheduleClient from "./ScheduleClient";

/** HR/HEAD only — the scheduling console. Server-gated so a non-manager who
 *  guesses the URL is redirected, not just hidden from the nav. */
export default async function SchedulePage() {
  const token = (await cookies()).get("kca_access_token")?.value ?? "";
  let role = "";
  try {
    role = verifyAccessToken(token).role;
  } catch {
    redirect("/login");
  }
  if (role !== "HR" && role !== "HEAD") {
    redirect(`/dashboard/${role.toLowerCase()}`);
  }
  return <ScheduleClient />;
}
