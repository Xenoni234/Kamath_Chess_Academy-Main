import { Suspense } from "react";
import AuthShell from "@/components/auth/AuthShell";
import LoginForm from "@/components/auth/LoginForm";

/**
 * Sign in.
 *
 * Just the form. This page briefly also carried a four-card portal picker, which
 * made the entrance to the app a decision before it was a login — and every
 * expired session in the app redirects here, so it put a choice in front of
 * people who only wanted to get back to what they were doing.
 *
 * The branded per-audience entrances still exist at /login/student, /login/parent,
 * /login/coach and /login/staff for anyone linked straight to them. They remain
 * presentation only: the account's role decides access, so which door you use
 * grants nothing.
 */
export default function LoginPage() {
  return (
    <AuthShell title="Sign In" subtitle="Access your KCA dashboard.">
      <Suspense fallback={<p className="text-center text-sm text-kca-gray-400">Loading…</p>}>
        <LoginForm />
      </Suspense>
    </AuthShell>
  );
}
