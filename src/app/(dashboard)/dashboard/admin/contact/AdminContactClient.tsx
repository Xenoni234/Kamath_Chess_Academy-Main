"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchWithAuth } from "@/lib/http/fetchWithAuth";

type ContactMessage = {
  id: string;
  name: string;
  email: string;
  mobile: string | null;
  message: string;
  handled: boolean;
  createdAt: string;
};

type Filter = "false" | "true" | "all";

const FILTERS: { value: Filter; label: string }[] = [
  { value: "false", label: "Open" },
  { value: "true", label: "Handled" },
  { value: "all", label: "All" },
];

/**
 * Staff view of public enquiries.
 *
 * Defaults to the open queue rather than everything, because the privacy policy
 * points DPDPA rights requests at this form — this list is a to-do list with a
 * legal response window attached, not an archive to browse.
 */
export default function AdminContactClient() {
  const [messages, setMessages] = useState<ContactMessage[]>([]);
  const [unhandled, setUnhandled] = useState(0);
  const [filter, setFilter] = useState<Filter>("false");
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetchWithAuth(`/api/admin/contact?handled=${filter}`);
      const data = await res.json();
      if (!res.ok || !data.success) {
        setError(data.message ?? "Could not load enquiries.");
        return;
      }
      setMessages(data.messages ?? []);
      setUnhandled(data.unhandled ?? 0);
      setError(null);
    } catch {
      setError("Could not load enquiries.");
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    // Async: state is set after an await, not synchronously in the effect body.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  async function setHandled(id: string, handled: boolean) {
    setBusyId(id);
    try {
      const res = await fetchWithAuth(`/api/admin/contact/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ handled }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setError(data.message ?? "Could not update that enquiry.");
        return;
      }
      await load();
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <h1 className="section-heading">Enquiries</h1>
      <p className="section-subheading mb-6">
        Messages from the public contact form. Requests to access, correct or delete personal data arrive here and carry
        a response deadline under the DPDPA — clear them promptly.
      </p>

      {error && <p className="mb-4 text-sm text-kca-danger">{error}</p>}

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="flex gap-1">
          {FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              onClick={() => setFilter(f.value)}
              className={`rounded px-3 py-1.5 text-sm transition ${
                filter === f.value ? "bg-kca-cyan text-black" : "bg-kca-surface-2 text-kca-gray-400 hover:text-kca-white"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
        <span className="text-sm text-kca-gray-400">
          {unhandled} open {unhandled === 1 ? "enquiry" : "enquiries"}
        </span>
      </div>

      {loading ? (
        <p className="text-sm text-kca-gray-400">Loading…</p>
      ) : messages.length === 0 ? (
        <div className="card text-sm text-kca-gray-400">
          {filter === "false" ? "Nothing open — the queue is clear." : "No enquiries to show."}
        </div>
      ) : (
        <ul className="space-y-3">
          {messages.map((m) => (
            <li key={m.id} className="card">
              <div className="mb-2 flex flex-wrap items-start justify-between gap-2">
                <div>
                  <div className="font-medium text-kca-white">{m.name}</div>
                  <div className="text-xs text-kca-gray-400">
                    <a href={`mailto:${m.email}`} className="hover:text-kca-cyan">
                      {m.email}
                    </a>
                    {m.mobile ? ` · ${m.mobile}` : ""}
                    {" · "}
                    {new Date(m.createdAt).toLocaleString("en-IN")}
                  </div>
                </div>
                <button
                  type="button"
                  disabled={busyId === m.id}
                  onClick={() => setHandled(m.id, !m.handled)}
                  className="text-xs text-kca-cyan hover:underline disabled:opacity-40"
                >
                  {m.handled ? "Reopen" : "Mark handled"}
                </button>
              </div>
              <p className="whitespace-pre-wrap text-sm text-kca-gray-100">{m.message}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
