"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Loader2, LogIn } from "lucide-react";
import AuthShell from "@/components/auth/AuthShell";

const roleRoutes: Record<string, string> = {
  STUDENT: "/dashboard/student",
  PARENT: "/dashboard/parent",
  COACH: "/dashboard/coach",
  HR: "/dashboard/hr",
  HEAD: "/dashboard/head",
};

export default function LoginPage() {
  const router = useRouter();
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setNotice("");
    setIsSubmitting(true);

    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier, password }),
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.message ?? "Sign in failed.");
      }

      router.push(roleRoutes[data.user.role] ?? "/dashboard/student");
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Sign in failed.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <AuthShell title="Sign In" subtitle="Access your KCA training dashboard.">
      <form onSubmit={onSubmit} className="space-y-5">
        {error && <div className="rounded-lg border border-kca-danger/20 bg-kca-danger/5 p-3 text-sm text-kca-danger">{error}</div>}
        {notice && <div className="rounded-lg border border-kca-warning/20 bg-kca-warning/5 p-3 text-sm text-kca-warning">{notice}</div>}
        <div>
          <label htmlFor="identifier" className="mb-2 block font-display text-xs font-semibold uppercase tracking-wider text-kca-gray-400">
            Email or Username
          </label>
          <input id="identifier" className="input-field" value={identifier} onChange={(event) => setIdentifier(event.target.value)} required />
        </div>
        <div>
          <div className="mb-2 flex items-center justify-between">
            <label htmlFor="password" className="block font-display text-xs font-semibold uppercase tracking-wider text-kca-gray-400">
              Password
            </label>
            <button
              type="button"
              onClick={() => setNotice("Password reset via email will be available in Phase 1 when email service is configured.")}
              className="text-xs font-semibold text-kca-cyan hover:underline bg-transparent border-none p-0 cursor-pointer"
            >
              Forgot Password
            </button>
          </div>
          <input id="password" type="password" className="input-field" value={password} onChange={(event) => setPassword(event.target.value)} required />
        </div>
        <button type="submit" className="btn-primary w-full" disabled={isSubmitting}>
          {isSubmitting ? <Loader2 className="h-5 w-5 animate-spin" /> : <LogIn className="h-5 w-5" />}
          Sign In
        </button>
      </form>
      <p className="mt-6 text-center text-sm text-kca-gray-400">
        New to KCA?{" "}
        <Link href="/register" className="font-semibold text-kca-cyan hover:underline">
          Create an account
        </Link>
      </p>
    </AuthShell>
  );
}
