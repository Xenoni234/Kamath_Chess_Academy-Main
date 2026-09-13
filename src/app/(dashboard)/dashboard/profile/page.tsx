"use client";

import { useCallback, useEffect, useState } from "react";
import { KeyRound, Loader2, UserRound } from "lucide-react";
import { fetchWithAuth } from "@/lib/http/fetchWithAuth";

type Profile = {
  username: string;
  email: string;
  mobile: string;
  role: string;
  bio: string | null;
  lichessId: string | null;
  chesscomId: string | null;
  fideId: string | null;
  isVerified: boolean;
  createdAt: string;
};

type Errors = Record<string, string>;

/**
 * Your own account: change your details, change your password.
 *
 * Available to every role, because every role has a password and none of them had a way to
 * change it — a student who thought someone had seen their password had no option but to
 * ask staff to reset it by hand.
 *
 * Email is shown but not editable. It is the address the account recovers through, so
 * changing it without proving control of the new one is a takeover path; the API refuses
 * it and this page says why rather than showing a field that silently fails.
 */
export default function ProfilePage() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState({ username: "", mobile: "", bio: "", lichessId: "", chesscomId: "", fideId: "" });
  const [errors, setErrors] = useState<Errors>({});
  const [notice, setNotice] = useState<{ kind: "ok" | "bad"; text: string } | null>(null);
  const [saving, setSaving] = useState(false);

  const [pw, setPw] = useState({ currentPassword: "", newPassword: "", confirm: "" });
  const [pwErrors, setPwErrors] = useState<Errors>({});
  const [pwNotice, setPwNotice] = useState<{ kind: "ok" | "bad"; text: string } | null>(null);
  const [pwSaving, setPwSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetchWithAuth("/api/user/profile");
      const data = await res.json();
      if (!res.ok || !data.success) {
        setNotice({ kind: "bad", text: data.message ?? "Could not load your profile." });
        return;
      }
      const p: Profile = data.profile;
      setProfile(p);
      setForm({
        username: p.username,
        mobile: p.mobile,
        bio: p.bio ?? "",
        lichessId: p.lichessId ?? "",
        chesscomId: p.chesscomId ?? "",
        fideId: p.fideId ?? "",
      });
    } catch {
      setNotice({ kind: "bad", text: "Could not load your profile." });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  async function saveProfile() {
    setSaving(true);
    setErrors({});
    setNotice(null);
    try {
      const res = await fetchWithAuth("/api/user/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "profile", ...form }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setErrors(data.errors ?? {});
        setNotice({ kind: "bad", text: data.message ?? "Could not save." });
        return;
      }
      setNotice({ kind: "ok", text: "Saved." });
      await load();
    } finally {
      setSaving(false);
    }
  }

  async function changePassword() {
    setPwErrors({});
    setPwNotice(null);

    // Checked here as well as on the server: the server never sees `confirm`, and telling
    // someone their passwords differ should not need a round trip.
    if (pw.newPassword !== pw.confirm) {
      setPwErrors({ confirm: "The two new passwords do not match" });
      return;
    }

    setPwSaving(true);
    try {
      const res = await fetchWithAuth("/api/user/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "password",
          currentPassword: pw.currentPassword,
          newPassword: pw.newPassword,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setPwErrors(data.errors ?? {});
        setPwNotice({ kind: "bad", text: data.message ?? "Could not change your password." });
        return;
      }
      setPw({ currentPassword: "", newPassword: "", confirm: "" });
      setPwNotice({ kind: "ok", text: "Password changed. Use the new one next time you sign in." });
    } finally {
      setPwSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-16 text-sm text-kca-gray-400">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading your profile…
      </div>
    );
  }

  const field = (
    name: keyof typeof form,
    label: string,
    opts: { placeholder?: string; hint?: string } = {},
  ) => (
    <div>
      <label htmlFor={name} className="mb-1 block text-xs uppercase tracking-wider text-kca-gray-400">
        {label}
      </label>
      <input
        id={name}
        value={form[name]}
        placeholder={opts.placeholder}
        onChange={(event) => setForm((f) => ({ ...f, [name]: event.target.value }))}
        className="input-field w-full"
      />
      {errors[name] ? (
        <p className="mt-1 text-xs text-kca-danger">{errors[name]}</p>
      ) : opts.hint ? (
        <p className="mt-1 text-xs text-kca-gray-400">{opts.hint}</p>
      ) : null}
    </div>
  );

  return (
    <div className="mx-auto w-full max-w-3xl">
      <h1 className="section-heading">My profile</h1>
      <p className="mb-6 text-sm text-kca-gray-400">
        Your details and your password. Only you can see this page.
      </p>

      {/* --- Details ------------------------------------------------------- */}
      <section className="card mb-6">
        <h2 className="mb-4 flex items-center gap-2 text-sm font-bold uppercase tracking-wider text-kca-white">
          <UserRound className="h-4 w-4 text-kca-cyan" /> Your details
        </h2>

        <div className="grid gap-4 sm:grid-cols-2">
          {field("username", "Username")}
          {field("mobile", "Mobile number")}

          <div className="sm:col-span-2">
            <label className="mb-1 block text-xs uppercase tracking-wider text-kca-gray-400">Email</label>
            <input value={profile?.email ?? ""} readOnly disabled className="input-field w-full opacity-60" />
            <p className="mt-1 text-xs text-kca-gray-400">
              This is how you get back into your account if you forget your password, so it cannot be
              changed here. Ask the academy if it needs to change.
            </p>
          </div>

          {field("lichessId", "Lichess username", { placeholder: "optional", hint: "Used for your game reports." })}
          {field("chesscomId", "Chess.com username", { placeholder: "optional" })}
          {field("fideId", "FIDE ID", { placeholder: "optional" })}

          <div className="sm:col-span-2">
            <label htmlFor="bio" className="mb-1 block text-xs uppercase tracking-wider text-kca-gray-400">
              About you
            </label>
            <textarea
              id="bio"
              value={form.bio}
              maxLength={280}
              rows={3}
              onChange={(event) => setForm((f) => ({ ...f, bio: event.target.value }))}
              className="input-field w-full resize-none"
            />
          </div>
        </div>

        {notice && (
          <p className={`mt-4 text-sm ${notice.kind === "ok" ? "text-kca-success" : "text-kca-danger"}`}>
            {notice.text}
          </p>
        )}

        <button type="button" onClick={saveProfile} disabled={saving} className="btn-primary mt-4 disabled:opacity-50">
          {saving ? "Saving…" : "Save changes"}
        </button>
      </section>

      {/* --- Password ------------------------------------------------------ */}
      <section className="card">
        <h2 className="mb-4 flex items-center gap-2 text-sm font-bold uppercase tracking-wider text-kca-white">
          <KeyRound className="h-4 w-4 text-kca-cyan" /> Change your password
        </h2>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label htmlFor="currentPassword" className="mb-1 block text-xs uppercase tracking-wider text-kca-gray-400">
              Current password
            </label>
            <input
              id="currentPassword"
              type="password"
              autoComplete="current-password"
              value={pw.currentPassword}
              onChange={(event) => setPw((v) => ({ ...v, currentPassword: event.target.value }))}
              className="input-field w-full"
            />
            {pwErrors.currentPassword && <p className="mt-1 text-xs text-kca-danger">{pwErrors.currentPassword}</p>}
          </div>

          <div>
            <label htmlFor="newPassword" className="mb-1 block text-xs uppercase tracking-wider text-kca-gray-400">
              New password
            </label>
            <input
              id="newPassword"
              type="password"
              autoComplete="new-password"
              value={pw.newPassword}
              onChange={(event) => setPw((v) => ({ ...v, newPassword: event.target.value }))}
              className="input-field w-full"
            />
            {pwErrors.newPassword ? (
              <p className="mt-1 text-xs text-kca-danger">{pwErrors.newPassword}</p>
            ) : (
              <p className="mt-1 text-xs text-kca-gray-400">
                At least 8 characters, with a capital letter, a small letter and a number.
              </p>
            )}
          </div>

          <div>
            <label htmlFor="confirm" className="mb-1 block text-xs uppercase tracking-wider text-kca-gray-400">
              Type it again
            </label>
            <input
              id="confirm"
              type="password"
              autoComplete="new-password"
              value={pw.confirm}
              onChange={(event) => setPw((v) => ({ ...v, confirm: event.target.value }))}
              className="input-field w-full"
            />
            {pwErrors.confirm && <p className="mt-1 text-xs text-kca-danger">{pwErrors.confirm}</p>}
          </div>
        </div>

        {pwNotice && (
          <p className={`mt-4 text-sm ${pwNotice.kind === "ok" ? "text-kca-success" : "text-kca-danger"}`}>
            {pwNotice.text}
          </p>
        )}

        <button
          type="button"
          onClick={changePassword}
          disabled={pwSaving || !pw.currentPassword || !pw.newPassword}
          className="btn-primary mt-4 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {pwSaving ? "Changing…" : "Change password"}
        </button>
      </section>
    </div>
  );
}
