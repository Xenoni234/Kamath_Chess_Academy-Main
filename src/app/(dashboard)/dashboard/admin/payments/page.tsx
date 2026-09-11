import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { verifyAccessToken } from "@/lib/auth";
import { hasRole } from "@/lib/authz";
import AdminPaymentsClient from "./AdminPaymentsClient";

/** HEAD only — the fee ledger. Fees are the academy owner's alone: not coaches,
 *  and not HR. See canViewMoney / canManageMoney in lib/authz. */
export default async function AdminPaymentsPage() {
  const token = (await cookies()).get("kca_access_token")?.value ?? "";
  let role = "";
  try {
    role = verifyAccessToken(token).role;
  } catch {
    redirect("/login");
  }
  if (!hasRole(role as never, ["HEAD"])) redirect(`/dashboard/${role.toLowerCase()}`);
  return <AdminPaymentsClient />;
}
