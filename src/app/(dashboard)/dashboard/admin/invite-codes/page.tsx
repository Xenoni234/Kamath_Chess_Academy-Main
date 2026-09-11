import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { verifyAccessToken } from "@/lib/auth";
import { hasRole } from "@/lib/authz";
import InviteCodesClient from "./InviteCodesClient";

/**
 * HEAD only — deliberately not HR.
 *
 * A code is the authority to create a staff account, so minting one is the power
 * to appoint colleagues. That belongs to the academy owner.
 */
export default async function InviteCodesPage() {
  const token = (await cookies()).get("kca_access_token")?.value ?? "";
  let role = "";
  try {
    role = verifyAccessToken(token).role;
  } catch {
    redirect("/login");
  }
  if (!hasRole(role as never, ["HEAD"])) redirect(`/dashboard/${role.toLowerCase()}`);
  return <InviteCodesClient />;
}
