import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { verifyAccessToken } from "@/lib/auth";
import { isPaymentsEnabled } from "@/lib/razorpay";
import StudentFeesClient from "./StudentFeesClient";

/**
 * A student's own fee record, and — once the gateway is live — a way to pay it.
 *
 * `isPaymentsEnabled()` is evaluated HERE, in a server component, and handed down
 * as a prop. It reads server-only secrets, so a client component importing it
 * would get `false` baked into the bundle at build time and the pay button would
 * silently never appear. Passing it as a prop is the only correct direction.
 */
export default async function StudentFeesPage() {
  const token = (await cookies()).get("kca_access_token")?.value ?? "";
  let userId = "";
  try {
    userId = verifyAccessToken(token).userId;
  } catch {
    redirect("/login");
  }
  return <StudentFeesClient userId={userId} paymentsEnabled={isPaymentsEnabled()} />;
}
