"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import AuthShell from "@/components/auth/AuthShell";

/**
 * Set or reset a password with an emailed code.
 *
 * Also the activation page for staff-created accounts: an invited coach, parent
 * or head receives a code here rather than a password, so there is exactly one
 * verified way to come to own a password.
 */
export default function ForgotPasswordPage() {
  const router = useRouter();
  const [step, setStep] = useState<1 | 2>(1);
  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [resendIn, setResendIn] = useState(0);

  useEffect(() => {
    if (resendIn <= 0) return;
    const t = setTimeout(() => setResendIn((n) => n - 1), 1000);
    return () => clearTimeout(t);
  }, [resendIn]);

  async function sendCode() {
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/auth/otp/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim().toLowerCase(), purpose: "reset" }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) {
        setError(data.message ?? "Could not send the code.");
        return;
      }
      // Deliberately the same message whether or not the address has an account —
      // otherwise this page tells strangers who is registered.
      setNotice("If that address has an account, a code is on its way. It expires in 10 minutes.");
      setStep(2);
      setResendIn(60);
    } catch {
      setError("Could not send the code. Check your connection.");
    } finally {
      setBusy(false);
    }
  }

  async function submitReset(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/auth/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim().toLowerCase(), otp, password, confirmPassword }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) {
        setError(data.message ?? "Could not set the password.");
        return;
      }
      setNotice("Password set. Redirecting you to sign in…");
      setTimeout(() => router.push("/login"), 1200);
    } catch {
      setError("Could not set the password.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell
      title={step === 1 ? "Set your password" : "Enter your code"}
      subtitle={step === 1 ? "We'll email you a one-time code." : "Then choose a new password."}
    >
      <div className="space-y-5">
        {error && <div className="rounded-lg border border-kca-danger/20 bg-kca-danger/5 p-3 text-sm text-kca-danger">{error}</div>}
        {notice && <div className="rounded-lg border border-kca-cyan/20 bg-kca-cyan/5 p-3 text-sm text-kca-gray-100">{notice}</div>}

        {step === 1 ? (
          <>
            <div>
              <label htmlFor="email" className="mb-2 block font-display text-xs font-semibold uppercase tracking-wider text-kca-gray-400">
                Email
              </label>
              <input id="email" type="email" className="input-field" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required />
            </div>
            <button type="button" className="btn-primary w-full py-2.5 disabled:opacity-50" disabled={busy || !email} onClick={() => void sendCode()}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Email me a code"}
            </button>
          </>
        ) : (
          <form onSubmit={submitReset} className="space-y-5">
            <div>
              <label htmlFor="otp" className="mb-2 block font-display text-xs font-semibold uppercase tracking-wider text-kca-gray-400">
                6-digit code
              </label>
              <input id="otp" inputMode="numeric" maxLength={6} className="input-field" value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, "").slice(0, 6))} required />
              <button type="button" className="mt-2 text-xs text-kca-gray-400 hover:text-kca-cyan disabled:opacity-50" disabled={busy || resendIn > 0} onClick={() => void sendCode()}>
                {resendIn > 0 ? `Resend in ${resendIn}s` : "Resend code"}
              </button>
            </div>
            <div>
              <label htmlFor="password" className="mb-2 block font-display text-xs font-semibold uppercase tracking-wider text-kca-gray-400">
                New password
              </label>
              <input id="password" type="password" className="input-field" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" required />
              <p className="mt-1 text-xs text-kca-gray-500">At least 8 characters.</p>
            </div>
            <div>
              <label htmlFor="confirm" className="mb-2 block font-display text-xs font-semibold uppercase tracking-wider text-kca-gray-400">
                Confirm password
              </label>
              <input id="confirm" type="password" className="input-field" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} autoComplete="new-password" required />
            </div>
            <button type="submit" className="btn-primary w-full py-2.5 disabled:opacity-50" disabled={busy}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Set password"}
            </button>
          </form>
        )}

        <p className="text-center text-sm text-kca-gray-400">
          <Link href="/login" className="text-kca-cyan hover:underline">Back to sign in</Link>
        </p>
      </div>
    </AuthShell>
  );
}
