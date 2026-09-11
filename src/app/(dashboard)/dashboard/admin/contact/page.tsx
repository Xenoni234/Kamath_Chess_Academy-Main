import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { verifyAccessToken } from "@/lib/auth";
import { hasRole } from "@/lib/authz";
import AdminContactClient from "./AdminContactClient";

/** HR/HEAD only — public enquiries, including DPDPA rights requests. */
export default async function AdminContactPage() {
  const token = (await cookies()).get("kca_access_token")?.value ?? "";
  let role = "";
  try {
    role = verifyAccessToken(token).role;
  } catch {
    redirect("/login");
  }
  if (!hasRole(role as never, ["HR", "HEAD"])) redirect(`/dashboard/${role.toLowerCase()}`);
  return <AdminContactClient />;
}
