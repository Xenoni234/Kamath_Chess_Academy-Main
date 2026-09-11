import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { verifyAccessToken } from "@/lib/auth";
import { hasRole } from "@/lib/authz";
import StudentList from "@/components/dashboard/StudentList";

/** COACH only — students in this coach's batches and classes. */
export default async function RosterPage() {
  const token = (await cookies()).get("kca_access_token")?.value ?? "";
  let role = "";
  try {
    role = verifyAccessToken(token).role;
  } catch {
    redirect("/login");
  }
  if (!hasRole(role as never, ["COACH", "HR", "HEAD"])) {
    redirect(`/dashboard/${role.toLowerCase()}`);
  }

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <h1 className="section-heading">My Students</h1>
      <p className="section-subheading mb-6">Everyone enrolled in the batches and classes you run.</p>
      <StudentList emptyMessage="No students yet — you'll see them here once a batch or class is assigned to you." />
    </div>
  );
}
