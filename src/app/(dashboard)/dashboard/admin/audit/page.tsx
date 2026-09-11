import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { verifyAccessToken } from "@/lib/auth";
import { hasRole } from "@/lib/authz";
import AuditLogClient from "./AuditLogClient";

/** HEAD only — a cross-platform activity feed is an owner-level capability. */
export default async function AuditPage() {
  const token = (await cookies()).get("kca_access_token")?.value ?? "";
  let role = "";
  try {
    role = verifyAccessToken(token).role;
  } catch {
    redirect("/login");
  }
  if (!hasRole(role as never, ["HEAD"])) redirect(`/dashboard/${role.toLowerCase()}`);
  return <AuditLogClient />;
}
