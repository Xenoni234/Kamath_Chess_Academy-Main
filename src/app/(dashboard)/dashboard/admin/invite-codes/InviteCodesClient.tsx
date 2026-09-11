"use client";

import { useCallback, useEffect, useState } from "react";

type InviteCode = {
  id: string;
  code: string;
  role: "COACH" | "HR";
  note: string | null;
  usedAt: string | null;
  revokedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
  usedBy: { username: string; email: string } | null;
  createdBy: { username: string } | null;
};

const ROLE_LABEL: Record<InviteCode["role"], string> = { COACH: "Coach", HR: "Academy staff" };

type Filter = "open" | "used" | "all";

/**
 * Issue the codes coaches and staff need in order to register.
 *
 * The freshly-minted code is shown once, large, with a copy button — it is the
 * only moment it is convenient to hand over. It remains readable in the table
 * below while unused, because the realistic failure here is the head closing the
 * tab before passing it on, not someone reading it over their shoulder.
 */
export default function InviteCodesClient() {
  const [codes, setCodes] = useState<InviteCode[]>([]);
  const [open, setOpen] = useState(0);
  const [filter, setFilter] = useState<Filter>("all");
  const [role, setRole] = useState<InviteCode["role"]>("COACH");
  const [note, setNote] = useState("");
  const [expiry, setExpiry] = useState("");
  const [minted, setMinted] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/admin/invite-codes?status=${filter}`);
      const data = await res.json();
      if (!res.ok || !data.success) {
        setError(data.message ?? "Could not load invite codes.");
        return;
      }
      setCodes(data.codes ?? []);
      setOpen(data.open ?? 0);
      setError(null);
    } catch {
      setError("Could not load invite codes.");
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    // Async: state is set after an await, not synchronously in the effect body.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  async function mint() {
    setBusy(true);
    setError(null);
    setCopied(false);
    try {
      const res = await fetch("/api/admin/invite-codes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          role,
          note: note.trim() || undefined,
          expiresInDays: expiry ? Number(expiry) : undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setError(data.message ?? "Could not create a code.");
        return;
      }
      setMinted(data.code);
      setNote("");
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/invite-codes/${id}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setError(data.message ?? "Could not withdraw that code.");
        return;
      }
      await load();
    } finally {
      setBusy(false);
    }
  }

  function statusOf(c: InviteCode): { label: string; tone: string } {
    if (c.usedAt) return { label: `used by ${c.usedBy?.username ?? "someone"}`, tone: "text-kca-gray-400" };
    if (c.revokedAt) return { label: "withdrawn", tone: "text-kca-danger" };
    if (c.expiresAt && new Date(c.expiresAt) < new Date()) return { label: "expired", tone: "text-kca-warning" };
    return { label: "open", tone: "text-kca-success" };
  }

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <h1 className="section-heading">Invite codes</h1>
      <p className="section-subheading mb-6">
        Coaches and academy staff cannot sign themselves up. Issue a code here, give it to the person, and they enter it
        when they register. Each code works once.
      </p>

      {error && <p className="mb-4 text-sm text-kca-danger">{error}</p>}

      {minted && (
        <div className="card mb-6 border-kca-cyan/40">
          <p className="mb-1 text-xs uppercase tracking-wider text-kca-gray-400">New code — give this to them</p>
          <div className="flex flex-wrap items-center gap-3">
            <code className="font-mono text-2xl font-bold tracking-wider text-kca-cyan">{minted}</code>
            <button
              type="button"
              className="btn-secondary px-3 py-1.5 text-xs"
              onClick={() => {
                navigator.clipboard?.writeText(minted).then(
                  () => setCopied(true),
                  () => setCopied(false),
                );
              }}
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        </div>
      )}

      <div className="card mb-6">
        <h2 className="mb-3 text-sm font-semibold text-kca-white">Create a code</h2>
        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <label htmlFor="inviteRole" className="mb-1 block text-xs text-kca-gray-400">
              For
            </label>
            <select
              id="inviteRole"
              className="input-field w-full py-2 text-sm"
              value={role}
              onChange={(e) => setRole(e.target.value as InviteCode["role"])}
            >
              <option value="COACH">Coach</option>
              <option value="HR">Academy staff</option>
            </select>
          </div>
          <div>
            <label htmlFor="inviteNote" className="mb-1 block text-xs text-kca-gray-400">
              Note (optional)
            </label>
            <input
              id="inviteNote"
              className="input-field w-full py-2 text-sm"
              placeholder="e.g. Priya, joining October"
              value={note}
              maxLength={120}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
          <div>
            <label htmlFor="inviteExpiry" className="mb-1 block text-xs text-kca-gray-400">
              Expires in (days)
            </label>
            <input
              id="inviteExpiry"
              type="number"
              min={1}
              max={365}
              className="input-field w-full py-2 text-sm"
              placeholder="never"
              value={expiry}
              onChange={(e) => setExpiry(e.target.value)}
            />
          </div>
        </div>
        <button type="button" className="btn-primary mt-3 px-4 py-2 text-sm" disabled={busy} onClick={mint}>
          {busy ? "Working…" : "Create code"}
        </button>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-3">
        <div className="flex gap-1">
          {(["open", "used", "all"] as Filter[]).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              className={`rounded px-3 py-1.5 text-sm capitalize transition ${
                filter === f ? "bg-kca-cyan text-black" : "bg-kca-surface-2 text-kca-gray-400 hover:text-kca-white"
              }`}
            >
              {f}
            </button>
          ))}
        </div>
        <span className="text-sm text-kca-gray-400">{open} open</span>
      </div>

      {loading ? (
        <p className="text-sm text-kca-gray-400">Loading…</p>
      ) : codes.length === 0 ? (
        <div className="card text-sm text-kca-gray-400">No codes to show.</div>
      ) : (
        <div className="card overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-kca-border text-left text-xs uppercase tracking-wider text-kca-gray-400">
                <th className="px-4 py-3">Code</th>
                <th className="px-4 py-3">For</th>
                <th className="px-4 py-3">Note</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3 text-right">&nbsp;</th>
              </tr>
            </thead>
            <tbody>
              {codes.map((c) => {
                const status = statusOf(c);
                const isOpen = !c.usedAt && !c.revokedAt;
                return (
                  <tr key={c.id} className="border-b border-kca-border/50 last:border-0">
                    <td className="px-4 py-3 font-mono text-kca-white">
                      {isOpen ? c.code : <span className="text-kca-gray-500">{c.code}</span>}
                    </td>
                    <td className="px-4 py-3 text-kca-gray-100">{ROLE_LABEL[c.role]}</td>
                    <td className="px-4 py-3 text-kca-gray-400">{c.note ?? "—"}</td>
                    <td className={`px-4 py-3 ${status.tone}`}>{status.label}</td>
                    <td className="px-4 py-3 text-right">
                      {isOpen && (
                        <button
                          type="button"
                          className="text-xs text-kca-danger hover:underline disabled:opacity-40"
                          disabled={busy}
                          onClick={() => revoke(c.id)}
                        >
                          Withdraw
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
