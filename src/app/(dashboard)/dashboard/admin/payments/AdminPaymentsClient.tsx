"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchWithAuth } from "@/lib/http/fetchWithAuth";

type Payment = {
  id: string;
  amount: number;
  status: string;
  method: string | null;
  description: string | null;
  dueDate: string | null;
  paidAt: string | null;
  createdAt: string;
  user: { id: string; username: string; email: string };
  invoice: { id: string; number: string } | null;
};
type Student = { id: string; username: string };

const METHODS = ["CASH", "UPI", "BANK", "CARD", "OTHER"];

/**
 * The fee ledger.
 *
 * These are offline records the academy keeps — cash, UPI, bank transfer. The
 * Razorpay scaffold stays disabled during the free testing period, so nothing
 * here takes a card or talks to a gateway.
 */
export default function AdminPaymentsClient() {
  const [payments, setPayments] = useState<Payment[]>([]);
  const [students, setStudents] = useState<Student[]>([]);
  const [statusFilter, setStatusFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    userId: "",
    amount: "",
    status: "COMPLETED",
    method: "CASH",
    description: "",
    dueDate: "",
  });

  const load = useCallback(async () => {
    const params = new URLSearchParams();
    if (statusFilter) params.set("status", statusFilter);
    const [pRes, sRes] = await Promise.all([fetchWithAuth(`/api/payments?${params}`), fetchWithAuth("/api/students")]);
    const [pData, sData] = await Promise.all([pRes.json(), sRes.json()]);
    if (pData.success) setPayments(pData.payments);
    else setError(pData.message ?? "Could not load fees.");
    if (sData.success) setStudents(sData.students);
  }, [statusFilter]);

  useEffect(() => {
    // The state here is set inside an async callback, after an await — not
    // synchronously in the effect body. The rule cannot see through the promise.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  async function record(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetchWithAuth("/api/payments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: form.userId,
          amount: Number(form.amount),
          status: form.status,
          method: form.method,
          description: form.description || undefined,
          dueDate: form.dueDate || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setError(data.message ?? "Could not record the payment.");
        return;
      }
      setForm({ userId: "", amount: "", status: "COMPLETED", method: "CASH", description: "", dueDate: "" });
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function settle(id: string) {
    setBusy(true);
    try {
      await fetchWithAuth(`/api/payments/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "COMPLETED" }),
      });
      await load();
    } finally {
      setBusy(false);
    }
  }

  const outstanding = payments.filter((p) => p.status === "PENDING").reduce((s, p) => s + p.amount, 0);
  const collected = payments.filter((p) => p.status === "COMPLETED").reduce((s, p) => s + p.amount, 0);

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <h1 className="section-heading">Fees</h1>
      <p className="section-subheading mb-6">Record payments and track dues. Offline records — no gateway.</p>

      {error && <div className="mb-4 rounded-lg border border-kca-danger/30 bg-kca-danger/5 p-3 text-sm text-kca-danger">{error}</div>}

      <div className="mb-6 grid gap-3 sm:grid-cols-2">
        <div className="card">
          <div className="text-xs uppercase tracking-wider text-kca-gray-400">Collected</div>
          <div className="mt-1 text-2xl font-semibold text-kca-success">₹{collected.toLocaleString("en-IN")}</div>
        </div>
        <div className="card">
          <div className="text-xs uppercase tracking-wider text-kca-gray-400">Outstanding</div>
          <div className="mt-1 text-2xl font-semibold text-kca-warning">₹{outstanding.toLocaleString("en-IN")}</div>
        </div>
      </div>

      <form onSubmit={record} className="card mb-6 space-y-3">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-kca-gray-400">Record a payment or due</h2>
        <div className="grid gap-3 sm:grid-cols-3">
          <select className="input-field py-2 text-sm" value={form.userId} onChange={(e) => setForm({ ...form, userId: e.target.value })} required>
            <option value="">Select student…</option>
            {students.map((s) => (
              <option key={s.id} value={s.id}>{s.username}</option>
            ))}
          </select>
          <input className="input-field py-2 text-sm" type="number" min="1" step="0.01" placeholder="Amount (₹)" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} required />
          <input className="input-field py-2 text-sm" placeholder="For, e.g. October tuition" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          <select className="input-field py-2 text-sm" value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
            <option value="COMPLETED">Paid</option>
            <option value="PENDING">Due</option>
          </select>
          <select className="input-field py-2 text-sm" value={form.method} onChange={(e) => setForm({ ...form, method: e.target.value })}>
            {METHODS.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
          {form.status === "PENDING" && (
            <input className="input-field py-2 text-sm" type="date" value={form.dueDate} onChange={(e) => setForm({ ...form, dueDate: e.target.value })} />
          )}
        </div>
        <button type="submit" className="btn-primary py-2 text-sm" disabled={busy}>Save</button>
      </form>

      <div className="mb-3">
        <select className="input-field w-44 py-2 text-sm" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          <option value="">All statuses</option>
          <option value="PENDING">Due</option>
          <option value="COMPLETED">Paid</option>
          <option value="REFUNDED">Refunded</option>
        </select>
      </div>

      <div className="card overflow-x-auto p-0">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-kca-border text-xs uppercase tracking-wider text-kca-gray-400">
              <th className="px-4 py-3">Student</th>
              <th className="px-4 py-3">For</th>
              <th className="px-4 py-3">Amount</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Date</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {payments.map((p) => (
              <tr key={p.id} className="border-b border-kca-border last:border-0">
                <td className="px-4 py-3 text-kca-white">{p.user.username}</td>
                <td className="px-4 py-3 text-kca-gray-400">{p.description ?? "—"}</td>
                <td className="px-4 py-3 font-mono text-kca-gray-100">₹{p.amount.toLocaleString("en-IN")}</td>
                <td className="px-4 py-3">
                  <span className={p.status === "COMPLETED" ? "text-kca-success" : p.status === "PENDING" ? "text-kca-warning" : "text-kca-gray-400"}>
                    {p.status}
                  </span>
                </td>
                <td className="px-4 py-3 text-xs text-kca-gray-500">
                  {new Date(p.paidAt ?? p.createdAt).toLocaleDateString("en-IN")}
                </td>
                <td className="px-4 py-3 text-right">
                  {p.invoice && (
                    <a
                      href={`/api/payments/${p.id}/invoice`}
                      title={p.invoice.number}
                      className="text-xs text-kca-cyan hover:underline"
                    >
                      Invoice
                    </a>
                  )}
                  {p.status === "PENDING" && (
                    <button type="button" className="ml-3 text-xs text-kca-cyan hover:underline disabled:opacity-40" disabled={busy} onClick={() => void settle(p.id)}>
                      Mark paid
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {payments.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-kca-gray-400">No fee records yet.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
