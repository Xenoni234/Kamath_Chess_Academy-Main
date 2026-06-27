"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { ArrowLeft, ArrowRight, CheckCircle, Loader2, UserPlus } from "lucide-react";
import AuthShell from "@/components/auth/AuthShell";

type FormState = {
  username: string;
  email: string;
  mobile: string;
  password: string;
  confirmPassword: string;
  fideId: string;
  lichessId: string;
  chesscomId: string;
  otp: string;
  agreedToTerms: boolean;
  agreedToAge: boolean;
  agreedToDataProcessing: boolean;
  agreedToMarketing: boolean;
  agreedToSms: boolean;
};

const initialForm: FormState = {
  username: "",
  email: "",
  mobile: "",
  password: "",
  confirmPassword: "",
  fideId: "",
  lichessId: "",
  chesscomId: "",
  otp: "",
  agreedToTerms: false,
  agreedToAge: false,
  agreedToDataProcessing: false,
  agreedToMarketing: false,
  agreedToSms: false,
};

export default function RegisterPage() {
  const router = useRouter();
  const [step, setStep] = useState(1);
  const [form, setForm] = useState<FormState>(initialForm);
  const [error, setError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const requiredConsentsReady = useMemo(
    () => form.agreedToTerms && form.agreedToAge && form.agreedToDataProcessing,
    [form.agreedToTerms, form.agreedToAge, form.agreedToDataProcessing]
  );

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (step < 3) {
      setStep((current) => current + 1);
      return;
    }

    setError("");
    setIsSubmitting(true);

    console.log("Register payload sent from frontend:", form);

    try {
      const response = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.message ?? "Registration failed.");
      }

      router.push("/login");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Registration failed.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <AuthShell title="Create Account" subtitle={`Step ${step} of 3`}>
      <div className="mb-6 grid grid-cols-3 gap-2">
        {[1, 2, 3].map((item) => (
          <div key={item} className={`h-1 rounded-full ${item <= step ? "bg-kca-cyan" : "bg-kca-border-bright"}`} />
        ))}
      </div>
      <form onSubmit={onSubmit} className="space-y-5">
        {error && <div className="rounded-lg border border-kca-danger/20 bg-kca-danger/5 p-3 text-sm text-kca-danger">{error}</div>}

        {step === 1 && (
          <>
            <TextField label="Username" value={form.username} onChange={(value) => update("username", value)} required />
            <TextField label="Email" type="email" value={form.email} onChange={(value) => update("email", value)} required />
            <TextField label="Mobile" value={form.mobile} onChange={(value) => update("mobile", value)} required />
            <TextField label="Password" type="password" value={form.password} onChange={(value) => update("password", value)} required />
            <TextField label="Confirm Password" type="password" value={form.confirmPassword} onChange={(value) => update("confirmPassword", value)} required />
          </>
        )}

        {step === 2 && (
          <>
            <TextField label="FIDE ID (Optional)" value={form.fideId} onChange={(value) => update("fideId", value)} />
            <TextField label="Lichess ID (Optional)" value={form.lichessId} onChange={(value) => update("lichessId", value)} />
            <TextField label="Chess.com ID (Optional)" value={form.chesscomId} onChange={(value) => update("chesscomId", value)} />
          </>
        )}

        {step === 3 && (
          <>
            {process.env.NODE_ENV === "development" && (
              <div className="rounded-lg border border-kca-warning/20 bg-kca-warning/5 p-3 text-sm text-kca-warning">
                Dev mode: use 000000 as OTP
              </div>
            )}
            <TextField label="OTP" inputMode="numeric" maxLength={6} value={form.otp} onChange={(value) => update("otp", value.replace(/\D/g, "").slice(0, 6))} required />
            <Checkbox checked={form.agreedToTerms} onChange={(checked) => update("agreedToTerms", checked)}>
              I agree to the{" "}
              <Link href="/terms" target="_blank" className="text-kca-cyan hover:underline">
                Terms of Service
              </Link>{" "}
              and{" "}
              <Link href="/privacy" target="_blank" className="text-kca-cyan hover:underline">
                Privacy Policy
              </Link>
            </Checkbox>
            <Checkbox checked={form.agreedToAge} onChange={(checked) => update("agreedToAge", checked)}>
              I confirm that the student is of appropriate age to participate in chess coaching, or I am a parent/guardian registering on their behalf
            </Checkbox>
            <Checkbox checked={form.agreedToDataProcessing} onChange={(checked) => update("agreedToDataProcessing", checked)}>
              I consent to KCA processing my personal data for chess coaching and platform services, as described in the Privacy Policy
            </Checkbox>
            <Checkbox checked={form.agreedToMarketing} onChange={(checked) => update("agreedToMarketing", checked)}>
              I agree to receive promotional emails, offers, and newsletters from KCA
            </Checkbox>
            <Checkbox checked={form.agreedToSms} onChange={(checked) => update("agreedToSms", checked)}>
              I agree to receive SMS notifications for class reminders and important updates
            </Checkbox>
          </>
        )}

        <div className="flex gap-3 pt-2">
          {step > 1 && (
            <button type="button" className="btn-secondary flex-1" onClick={() => setStep((current) => current - 1)}>
              <ArrowLeft className="h-5 w-5" />
              Back
            </button>
          )}
          <button type="submit" className="btn-primary flex-1" disabled={isSubmitting || (step === 3 && (!requiredConsentsReady || form.otp.length !== 6))}>
            {isSubmitting ? <Loader2 className="h-5 w-5 animate-spin" /> : step === 3 ? <UserPlus className="h-5 w-5" /> : <ArrowRight className="h-5 w-5" />}
            {step === 3 ? "Create Account" : "Continue"}
          </button>
        </div>
      </form>
      <p className="mt-6 text-center text-sm text-kca-gray-400">
        Already registered?{" "}
        <Link href="/login" className="font-semibold text-kca-cyan hover:underline">
          Sign in
        </Link>
      </p>
    </AuthShell>
  );
}

function TextField({
  label,
  value,
  onChange,
  type = "text",
  required = false,
  inputMode,
  maxLength,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  required?: boolean;
  inputMode?: React.HTMLAttributes<HTMLInputElement>["inputMode"];
  maxLength?: number;
}) {
  const id = label.toLowerCase().replace(/[^a-z0-9]+/g, "-");

  return (
    <div>
      <label htmlFor={id} className="mb-2 block font-display text-xs font-semibold uppercase tracking-wider text-kca-gray-400">
        {label}
      </label>
      <input id={id} className="input-field" type={type} value={value} onChange={(event) => onChange(event.target.value)} required={required} inputMode={inputMode} maxLength={maxLength} />
    </div>
  );
}

function Checkbox({
  checked,
  onChange,
  children,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <label className="flex gap-3 rounded-lg border border-kca-border bg-kca-black p-3 text-sm leading-relaxed text-kca-gray-100">
      <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded border border-kca-border-bright bg-kca-surface-2">
        <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} className="sr-only" />
        {checked && <CheckCircle className="h-4 w-4 text-kca-cyan" />}
      </span>
      <span>{children}</span>
    </label>
  );
}
