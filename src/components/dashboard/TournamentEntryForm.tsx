"use client";

import { useCallback, useEffect, useState } from "react";
import { ClipboardList, Loader2 } from "lucide-react";
import { fetchWithAuth } from "@/lib/http/fetchWithAuth";

type Registration = {
  id: string;
  userId: string;
  fullName: string;
  phone: string;
  dateOfBirth: string | null;
  rating: string | null;
  fideId: string | null;
  notes: string | null;
  status: string;
  createdAt: string;
  user: { username: string };
};

/**
 * The entry form for an over-the-board tournament, and — for staff — the list of who has
 * entered.
 *
 * One component for both because the server decides which you get: `GET` returns every
 * entry to staff and only your own to a player, and it is that response which drives what
 * renders here. The page does not choose; it reflects.
 *
 * Only shown for `isOffline` tournaments. An event played on the platform needs a Join
 * button and a pairing record, not a name and a phone number.
 */
export default function TournamentEntryForm({
  tournamentId,
  closed,
}: {
  tournamentId: string;
  closed: boolean;
}) {
  const [rows, setRows] = useState<Registration[]>([]);
  const [isStaff, setIsStaff] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<{ kind: "ok" | "bad"; text: string } | null>(null);
  const [form, setForm] = useState({
    fullName: "",
    phone: "",
    dateOfBirth: "",
    rating: "",
    fideId: "",
    notes: "",
  });

  const load = useCallback(async () => {
    try {
      const res = await fetchWithAuth(`/api/tournaments/${tournamentId}/register`);
      const data = await res.json();
      if (!res.ok || !data.success) return;
      setIsStaff(Boolean(data.isStaff));
      setRows(data.registrations ?? []);

      // A player has at most one entry; pre-fill so "edit my details" is the same form
      // rather than a separate screen.
      if (!data.isStaff && data.registrations?.length === 1) {
        const mine: Registration = data.registrations[0];
        setForm({
          fullName: mine.fullName,
          phone: mine.phone,
          dateOfBirth: mine.dateOfBirth ? mine.dateOfBirth.slice(0, 10) : "",
          rating: mine.rating ?? "",
          fideId: mine.fideId ?? "",
          notes: mine.notes ?? "",
        });
      }
    } finally {
      setLoading(false);
    }
  }, [tournamentId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function submit() {
    setSaving(true);
    setErrors({});
    setNotice(null);
    try {
      const res = await fetchWithAuth(`/api/tournaments/${tournamentId}/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setErrors(data.errors ?? {});
        setNotice({ kind: "bad", text: data.message ?? "Could not send your entry." });
        return;
      }
      setNotice({ kind: "ok", text: "Entry sent. The academy will confirm your place." });
      await load();
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="card flex items-center gap-2 text-sm text-kca-gray-400">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading…
      </div>
    );
  }

  // ---- Staff: who has entered ---------------------------------------------
  if (isStaff) {
    return (
      <section className="card">
        <h2 className="mb-4 flex items-center gap-2 text-sm font-bold uppercase tracking-wider text-kca-white">
          <ClipboardList className="h-4 w-4 text-kca-cyan" /> Entries ({rows.length})
        </h2>

        {rows.length === 0 ? (
          <p className="text-sm text-kca-gray-400">Nobody has entered yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[40rem] text-left text-sm">
              <thead className="border-b border-kca-border text-xs uppercase tracking-wider text-kca-gray-400">
                <tr>
                  <th className="py-2 pr-4">Name</th>
                  <th className="py-2 pr-4">Account</th>
                  <th className="py-2 pr-4">Phone</th>
                  <th className="py-2 pr-4">Born</th>
                  <th className="py-2 pr-4">Rating</th>
                  <th className="py-2">Notes</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-b border-kca-border/50 last:border-0">
                    <td className="py-2 pr-4 text-kca-white">{r.fullName}</td>
                    <td className="py-2 pr-4 text-kca-gray-400">{r.user.username}</td>
                    <td className="py-2 pr-4 font-mono text-xs text-kca-gray-100">{r.phone}</td>
                    <td className="py-2 pr-4 text-kca-gray-400">
                      {r.dateOfBirth ? new Date(r.dateOfBirth).toLocaleDateString("en-IN") : "—"}
                    </td>
                    <td className="py-2 pr-4 text-kca-gray-400">{r.rating ?? "—"}</td>
                    <td className="py-2 text-kca-gray-400">{r.notes ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    );
  }

  // ---- Player: the entry form ---------------------------------------------
  const already = rows.length === 1;

  return (
    <section className="card">
      <h2 className="mb-1 flex items-center gap-2 text-sm font-bold uppercase tracking-wider text-kca-white">
        <ClipboardList className="h-4 w-4 text-kca-cyan" /> {already ? "Your entry" : "Enter this tournament"}
      </h2>
      <p className="mb-4 text-xs text-kca-gray-400">
        {already
          ? "You have entered. You can change these details until entries close."
          : "Fill this in and the academy will confirm your place."}
      </p>

      {closed ? (
        <p className="text-sm text-kca-gray-400">Entries for this tournament are closed.</p>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            {(
              [
                ["fullName", "Full name", "As it should appear on the pairing sheet", "text"],
                ["phone", "Contact number", "", "tel"],
                ["dateOfBirth", "Date of birth", "Used for age groups", "date"],
                ["rating", "Your rating", "FIDE, Lichess or none", "text"],
                ["fideId", "FIDE ID", "Optional", "text"],
              ] as const
            ).map(([name, label, hint, type]) => (
              <div key={name}>
                <label htmlFor={name} className="mb-1 block text-xs uppercase tracking-wider text-kca-gray-400">
                  {label}
                </label>
                <input
                  id={name}
                  type={type}
                  value={form[name]}
                  onChange={(event) => setForm((f) => ({ ...f, [name]: event.target.value }))}
                  className="input-field w-full"
                />
                {errors[name] ? (
                  <p className="mt-1 text-xs text-kca-danger">{errors[name]}</p>
                ) : hint ? (
                  <p className="mt-1 text-xs text-kca-gray-400">{hint}</p>
                ) : null}
              </div>
            ))}

            <div className="sm:col-span-2">
              <label htmlFor="notes" className="mb-1 block text-xs uppercase tracking-wider text-kca-gray-400">
                Anything the organiser should know
              </label>
              <textarea
                id="notes"
                rows={2}
                maxLength={500}
                value={form.notes}
                onChange={(event) => setForm((f) => ({ ...f, notes: event.target.value }))}
                className="input-field w-full resize-none"
              />
            </div>
          </div>

          {notice && (
            <p className={`mt-4 text-sm ${notice.kind === "ok" ? "text-kca-success" : "text-kca-danger"}`}>
              {notice.text}
            </p>
          )}

          <button
            type="button"
            onClick={submit}
            disabled={saving || !form.fullName.trim() || !form.phone.trim()}
            className="btn-primary mt-4 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saving ? "Sending…" : already ? "Update my entry" : "Send my entry"}
          </button>
        </>
      )}
    </section>
  );
}
