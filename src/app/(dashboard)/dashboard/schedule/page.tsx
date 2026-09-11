import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { verifyAccessToken } from "@/lib/auth";
import ScheduleClient from "./ScheduleClient";

/**
 * The scheduling console. Server-gated so someone who guesses the URL is
 * redirected, not merely hidden from the nav.
 *
 * A coach reaches it too, but sees a narrower page: their own batches and a
 * "Schedule class" button, and nothing else. Building the academy's structure —
 * creating batches, assigning coaches, enrolling students — stays with HR and the
 * head. A coach arranging an extra session for their own students should not have
 * to ask anyone, and equally should not be able to schedule into someone else's
 * batch. `POST /api/classes` enforces that server-side; this only decides what is
 * worth rendering.
 */
export default async function SchedulePage() {
  const token = (await cookies()).get("kca_access_token")?.value ?? "";
  let role = "";
  try {
    role = verifyAccessToken(token).role;
  } catch {
    redirect("/login");
  }
  if (role !== "HR" && role !== "HEAD" && role !== "COACH") {
    redirect(`/dashboard/${role.toLowerCase()}`);
  }
  return <ScheduleClient role={role} />;
}
