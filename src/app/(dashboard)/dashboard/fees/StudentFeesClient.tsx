"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchWithAuth } from "@/lib/http/fetchWithAuth";

type Payment = {
  id: string;
  amount: number;
  currency: string;
  status: "PENDING" | "COMPLETED" | "FAILED" | "REFUNDED";
  method: string | null;
  description: string | null;
  dueDate: string | null;
  paidAt: string | null;
  createdAt: string;
  invoice: { id: string; number: string } | null;
};

declare global {
  interface Window {
    Razorpay?: new (options: Record<string, unknown>) => { open: () => void };
  }
}

const STATUS_TONE: Record<Payment["status"], string> = {
  PENDING: "text-kca-warning",
  COMPLETED: "text-kca-success",
  FAILED: "text-kca-danger",
  REFUNDED: "text-kca-gray-400",
};

/**
 * A student's fee ledger.
 *
 * `paymentsEnabled` arrives as a prop from the server component — see that file
 * for why it cannot be read here. When it is false the page is a read-only
 * record, which is the correct state during the free testing period.
 *
 * The pay flow is deliberately thin: the browser only ever names a `paymentId`,
 * and the server decides the amount from that row. Nothing here can propose a
 * price. The checkout callback is treated as a UI hint, not proof — the webhook
 * is what actually settles, so this just re-fetches and lets the server's answer
 * be the truth.
 */
export default function StudentFeesClient({
  userId,
  paymentsEnabled,
}: {
  userId: string;
  paymentsEnabled: boolean;
}) {
  const [payments, setPayments] = useState<Payment[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetchWithAuth(`/api/payments?userId=${encodeURIComponent(userId)}`);
      const data = await res.json();
      if (!res.ok || !data.success) {
        setError(data.message ?? "Could not load your fee record.");
        return;
      }
      setPayments(data.payments ?? []);
      setError(null);
    } catch {
      setError("Could not load your fee record.");
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    // Async: state is set after an await, not synchronously in the effect body.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  async function pay(payment: Payment) {
    setBusyId(payment.id);
    setError(null);
    setNotice(null);
    try {
      const res = await fetchWithAuth("/api/payments/order", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paymentId: payment.id }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setError(data.message ?? "Could not start the payment.");
        return;
      }

      await loadCheckoutScript();
      if (!window.Razorpay) {
        setError("The payment window could not load. Please check your connection and try again.");
        return;
      }

      const checkout = new window.Razorpay({
        key: data.keyId,
        order_id: data.orderId,
        amount: data.amount,
        currency: data.currency,
        name: "Kamath Chess Academy",
        description: payment.description ?? "Academy fees",
        handler: () => {
          // The gateway confirms settlement through the webhook; this callback is
          // only a cue to refresh. If it never fires (the browser closed), the
          // payment still completes server-side.
          setNotice("Payment received — your record will update in a moment.");
          setTimeout(() => void load(), 2500);
        },
        modal: { ondismiss: () => setNotice("Payment cancelled.") },
      });
      checkout.open();
    } catch {
      setError("Could not start the payment.");
    } finally {
      setBusyId(null);
    }
  }

  const outstanding = payments
    .filter((p) => p.status === "PENDING")
    .reduce((sum, p) => sum + p.amount, 0);

  return (
    <div className="mx-auto max-w-4xl px-4 py-8">
      <h1 className="section-heading">Fees</h1>
      <p className="section-subheading mb-6">
        Your payment record with the academy.{" "}
        {!paymentsEnabled && "Online payment is not enabled yet — fees are settled with the academy directly."}
      </p>

      {error && <p className="mb-4 text-sm text-kca-danger">{error}</p>}
      {notice && <p className="mb-4 text-sm text-kca-cyan">{notice}</p>}

      <div className="card mb-6">
        <div className="text-xs uppercase tracking-wider text-kca-gray-400">Outstanding</div>
        <div className="text-2xl font-semibold text-kca-white">₹{outstanding.toFixed(2)}</div>
      </div>

      {loading ? (
        <p className="text-sm text-kca-gray-400">Loading…</p>
      ) : payments.length === 0 ? (
        <div className="card text-sm text-kca-gray-400">
          Nothing recorded yet. The platform is free during the current testing period.
        </div>
      ) : (
        <div className="card overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-kca-border text-left text-xs uppercase tracking-wider text-kca-gray-400">
                <th className="px-4 py-3">For</th>
                <th className="px-4 py-3">Amount</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Date</th>
                <th className="px-4 py-3 text-right">&nbsp;</th>
              </tr>
            </thead>
            <tbody>
              {payments.map((p) => (
                <tr key={p.id} className="border-b border-kca-border/50 last:border-0">
                  <td className="px-4 py-3 text-kca-gray-100">{p.description ?? "Academy fees"}</td>
                  <td className="px-4 py-3 text-kca-white">₹{p.amount.toFixed(2)}</td>
                  <td className={`px-4 py-3 ${STATUS_TONE[p.status]}`}>{p.status.toLowerCase()}</td>
                  <td className="px-4 py-3 text-kca-gray-400">
                    {new Date(p.paidAt ?? p.dueDate ?? p.createdAt).toLocaleDateString("en-IN")}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {p.invoice && (
                      <a
                        href={`/api/payments/${p.id}/invoice`}
                        className="text-xs text-kca-cyan hover:underline"
                      >
                        Invoice
                      </a>
                    )}
                    {paymentsEnabled && p.status === "PENDING" && (
                      <button
                        type="button"
                        disabled={busyId === p.id}
                        onClick={() => pay(p)}
                        className="ml-3 text-xs text-kca-cyan hover:underline disabled:opacity-40"
                      >
                        {busyId === p.id ? "Opening…" : "Pay now"}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** Load Razorpay's checkout script once, on demand. */
function loadCheckoutScript(): Promise<void> {
  const SCRIPT_ID = "razorpay-checkout";
  if (window.Razorpay) return Promise.resolve();
  const existing = document.getElementById(SCRIPT_ID);
  if (existing) {
    return new Promise((resolve) => existing.addEventListener("load", () => resolve(), { once: true }));
  }
  return new Promise((resolve) => {
    const script = document.createElement("script");
    script.id = SCRIPT_ID;
    script.src = "https://checkout.razorpay.com/v1/checkout.js";
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => resolve();
    document.body.appendChild(script);
  });
}
