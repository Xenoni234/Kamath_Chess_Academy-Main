"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { Loader2, LogIn } from "lucide-react";
import { DASHBOARD_FOR_ROLE, portalForRole, type Portal } from "@/lib/portals";
import type { Role } from "@prisma/client";

/**
 * The sign-in form, shared by every portal.
 *
 * Renders the form ONLY. The surrounding page owns the `AuthShell`, because this
 * component used to bring its own and the /login picker rendered above it — two
 * full-height shells stacked, with a viewport-sized gap in between.
 *
 * When `portal` is given and the account belongs to a different audience, the
 * user is told which entrance is theirs and sent to their own dashboard. That is
 * a signpost, not a security boundary: authorisation lives on the account's role
 * (proxy.ts, page guards, requireRole), so using the "wrong" door grants nothing.
 */
export default function LoginForm({ portal }: { portal?: Portal }) {
  const router = useRouter();
  const searchParams = useSearchParams();
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

      const role = data.user.role as Role;

      if (portal && !portal.roles.includes(role)) {
        const theirs = portalForRole(role);
        setNotice(`This is the ${portal.title.replace(" Sign In", "").toLowerCase()} entrance — taking you to your ${theirs.key} dashboard.`);
      }

      // Resume where they were headed before the session expired. Only same-site
      // dashboard paths are honoured, so `next` can never become an open redirect.
      const next = searchParams.get("next");
      const home = DASHBOARD_FOR_ROLE[role] ?? "/dashboard/student";
      const destination = next && next.startsWith("/dashboard") && !next.startsWith("//") ? next : home;

      router.push(destination);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Sign in failed.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-5">
      {error && <div className="rounded-lg border border-kca-danger/20 bg-kca-danger/5 p-3 text-sm text-kca-danger">{error}</div>}
      {notice && <div className="rounded-lg border border-kca-warning/20 bg-kca-warning/5 p-3 text-sm text-kca-warning">{notice}</div>}

      <div>
        <label htmlFor="identifier" className="mb-2 block font-display text-xs font-semibold uppercase tracking-wider text-kca-gray-400">
          Email or Username
        </label>
        <input
          id="identifier"
          className="input-field"
          value={identifier}
          onChange={(e) => setIdentifier(e.target.value)}
          autoComplete="username"
          required
        />
      </div>

      <div>
        <label htmlFor="password" className="mb-2 block font-display text-xs font-semibold uppercase tracking-wider text-kca-gray-400">
          Password
        </label>
        <input
          id="password"
          type="password"
          className="input-field"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          required
        />
        <div className="mt-2 text-right">
          <Link href="/forgot-password" className="text-xs text-kca-gray-400 hover:text-kca-cyan">
            Forgot password?
          </Link>
        </div>
      </div>

      <button type="submit" disabled={isSubmitting} className="btn-primary w-full py-2.5 disabled:opacity-50">
        {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : (<><LogIn className="h-4 w-4" /> Sign In</>)}
      </button>

      <div className="space-y-2 pt-2 text-center text-sm text-kca-gray-400">
        <p>
          New student?{" "}
          <Link href="/register" className="text-kca-cyan hover:underline">
            Create an account
          </Link>
        </p>
        {portal && (
          <p>
            <Link href="/login" className="text-xs text-kca-gray-500 hover:text-kca-cyan">
              Not a {portal.key}? Sign in here
            </Link>
          </p>
        )}
    </div>
    </form>
  );
}
