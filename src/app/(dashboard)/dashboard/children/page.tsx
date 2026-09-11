import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { verifyAccessToken } from "@/lib/auth";
import { hasRole } from "@/lib/authz";
import StudentList from "@/components/dashboard/StudentList";

/** PARENT only — the children linked to this account. */
export default async function ChildrenPage() {
  const token = (await cookies()).get("kca_access_token")?.value ?? "";
  let role = "";
  try {
    role = verifyAccessToken(token).role;
  } catch {
    redirect("/login");
  }
  if (!hasRole(role as never, ["PARENT", "HR", "HEAD"])) {
    redirect(`/dashboard/${role.toLowerCase()}`);
  }

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <h1 className="section-heading">My Children</h1>
      <p className="section-subheading mb-6">
        Progress, classes, attendance and fees for each child linked to your account.
      </p>
      <StudentList emptyMessage="No children are linked to your account yet — the academy office can link them for you." />
    </div>
  );
}
