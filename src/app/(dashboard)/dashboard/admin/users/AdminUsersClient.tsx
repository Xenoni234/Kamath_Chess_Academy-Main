"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchWithAuth } from "@/lib/http/fetchWithAuth";

type LinkedChild = { student: { id: string; username: string } };
type User = {
  id: string;
  username: string;
  email: string;
  mobile: string;
  role: string;
  isActive: boolean;
  isVerified: boolean;
  parentLinks: LinkedChild[];
};

const ROLES = ["STUDENT", "PARENT", "COACH", "HR", "HEAD"] as const;
const HR_CREATABLE = ["STUDENT", "PARENT", "COACH"];

export default function AdminUsersClient({ viewerRole }: { viewerRole: string }) {
  const [users, setUsers] = useState<User[]>([]);
  /**
   * Seeded from `?role=` so the Head dashboard's "Coaches" card can land here already
   * filtered. Read once, as the initial value — reading it on every render would fight
   * the user the moment they changed the dropdown.
   */
  const [roleFilter, setRoleFilter] = useState(() => {
    if (typeof window === "undefined") return "";
    const wanted = new URLSearchParams(window.location.search).get("role") ?? "";
    return ["STUDENT", "PARENT", "COACH", "HR", "HEAD"].includes(wanted) ? wanted : "";
  });
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({ username: "", email: "", mobile: "", role: "STUDENT" });
  const [link, setLink] = useState({ parentId: "", studentId: "" });

  const isHead = viewerRole === "HEAD";
  const creatable = isHead ? ROLES : ROLES.filter((r) => HR_CREATABLE.includes(r));

  const load = useCallback(async () => {
    const params = new URLSearchParams();
    if (roleFilter) params.set("role", roleFilter);
    if (q.trim()) params.set("q", q.trim());
    const res = await fetchWithAuth(`/api/admin/users?${params}`);
    const data = await res.json();
    if (data.success) setUsers(data.users);
    else setMessage({ tone: "err", text: data.message ?? "Could not load accounts." });
  }, [roleFilter, q]);

  useEffect(() => {
    // The state here is set inside an async callback, after an await — not
    // synchronously in the effect body. The rule cannot see through the promise.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  async function createUser(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetchWithAuth("/api/admin/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setMessage({ tone: "err", text: data.message ?? "Could not create the account." });
        return;
      }
      setMessage({
        tone: "ok",
        text: data.invited
          ? `${form.username} created — an activation code has been emailed.`
          : `${form.username} created, but the invite email failed. They can request one at "Forgot password".`,
      });
      setForm({ username: "", email: "", mobile: "", role: "STUDENT" });
      setShowCreate(false);
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function patchUser(id: string, body: Record<string, unknown>) {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetchWithAuth(`/api/admin/users/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setMessage({ tone: "err", text: data.message ?? "Update failed." });
        return;
      }
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function linkParent(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetchWithAuth("/api/admin/parent-links", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(link),
      });
      const data = await res.json();
      setMessage(
        res.ok && data.success
          ? { tone: "ok", text: "Parent linked to student." }
          : { tone: "err", text: data.message ?? "Could not link." },
      );
      if (res.ok && data.success) {
        setLink({ parentId: "", studentId: "" });
        await load();
      }
    } finally {
      setBusy(false);
    }
  }

  const parents = users.filter((u) => u.role === "PARENT");
  const students = users.filter((u) => u.role === "STUDENT");

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="section-heading">People</h1>
          <p className="section-subheading">Accounts, roles and parent links.</p>
        </div>
        <button type="button" className="btn-primary py-2 text-sm" onClick={() => setShowCreate((v) => !v)}>
          {showCreate ? "Cancel" : "Add person"}
        </button>
      </div>

      {message && (
        <div
          className={`mb-4 rounded-lg border p-3 text-sm ${
            message.tone === "ok"
              ? "border-kca-cyan/30 bg-kca-cyan/5 text-kca-gray-100"
              : "border-kca-danger/30 bg-kca-danger/5 text-kca-danger"
          }`}
        >
          {message.text}
        </div>
      )}

      {showCreate && (
        <form onSubmit={createUser} className="card mb-6 space-y-3">
          <p className="text-xs text-kca-gray-400">
            No password is set here — the person receives a one-time code and chooses their own.
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <input className="input-field py-2 text-sm" placeholder="Username" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} required />
            <input className="input-field py-2 text-sm" type="email" placeholder="Email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required />
            <input className="input-field py-2 text-sm" placeholder="Mobile" value={form.mobile} onChange={(e) => setForm({ ...form, mobile: e.target.value })} required />
            <select className="input-field py-2 text-sm" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
              {creatable.map((r) => (
                <option key={r} value={r}>{r}</option>
              ))}
            </select>
          </div>
          {!isHead && <p className="text-xs text-kca-gray-500">Only the academy head can create HR or HEAD accounts.</p>}
          <button type="submit" className="btn-primary py-2 text-sm" disabled={busy}>Create &amp; send invite</button>
        </form>
      )}

      <div className="mb-4 flex flex-wrap gap-2">
        <input className="input-field max-w-xs py-2 text-sm" placeholder="Search name or email" value={q} onChange={(e) => setQ(e.target.value)} />
        <select className="input-field w-40 py-2 text-sm" value={roleFilter} onChange={(e) => setRoleFilter(e.target.value)}>
          <option value="">All roles</option>
          {ROLES.map((r) => (
            <option key={r} value={r}>{r}</option>
          ))}
        </select>
      </div>

      <div className="card mb-6 overflow-x-auto p-0">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-kca-border text-xs uppercase tracking-wider text-kca-gray-400">
              <th className="px-4 py-3">Name</th>
              <th className="px-4 py-3">Email</th>
              <th className="px-4 py-3">Role</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Children</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} className="border-b border-kca-border last:border-0">
                <td className="px-4 py-3 text-kca-white">{u.username}</td>
                <td className="truncate px-4 py-3 text-kca-gray-400">{u.email}</td>
                <td className="px-4 py-3">
                  {isHead ? (
                    <select
                      className="rounded border border-kca-border bg-kca-surface-3 px-2 py-1 text-xs text-kca-white"
                      value={u.role}
                      disabled={busy}
                      onChange={(e) => void patchUser(u.id, { role: e.target.value })}
                    >
                      {ROLES.map((r) => (
                        <option key={r} value={r}>{r}</option>
                      ))}
                    </select>
                  ) : (
                    <span className="text-kca-gray-100">{u.role}</span>
                  )}
                </td>
                <td className="px-4 py-3">
                  <span className={u.isActive ? "text-kca-success" : "text-kca-danger"}>
                    {u.isActive ? "active" : "disabled"}
                  </span>
                  {!u.isVerified && <span className="ml-2 text-xs text-kca-warning">unverified</span>}
                </td>
                <td className="px-4 py-3 text-xs text-kca-gray-400">
                  {u.parentLinks.length ? u.parentLinks.map((l) => l.student.username).join(", ") : "—"}
                </td>
                <td className="px-4 py-3 text-right">
                  <button
                    type="button"
                    className="text-xs text-kca-gray-400 hover:text-kca-cyan disabled:opacity-40"
                    disabled={busy}
                    onClick={() => void patchUser(u.id, { isActive: !u.isActive })}
                  >
                    {u.isActive ? "Disable" : "Enable"}
                  </button>
                </td>
              </tr>
            ))}
            {users.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-kca-gray-400">No accounts match.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <form onSubmit={linkParent} className="card space-y-3">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-kca-gray-400">Link a parent to a child</h2>
        <p className="text-xs text-kca-gray-500">
          A parent sees nothing until they are linked — this is what makes their dashboard work.
        </p>
        <div className="grid gap-3 sm:grid-cols-3">
          <select className="input-field py-2 text-sm" value={link.parentId} onChange={(e) => setLink({ ...link, parentId: e.target.value })} required>
            <option value="">Select parent…</option>
            {parents.map((p) => (
              <option key={p.id} value={p.id}>{p.username}</option>
            ))}
          </select>
          <select className="input-field py-2 text-sm" value={link.studentId} onChange={(e) => setLink({ ...link, studentId: e.target.value })} required>
            <option value="">Select student…</option>
            {students.map((s) => (
              <option key={s.id} value={s.id}>{s.username}</option>
            ))}
          </select>
          <button type="submit" className="btn-secondary py-2 text-sm" disabled={busy}>Link</button>
        </div>
      </form>
    </div>
  );
}
