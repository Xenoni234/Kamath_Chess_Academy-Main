"use client";

import { useCallback, useEffect, useState } from "react";
import { auditActionLabel } from "@/lib/auditActions";

type Entry = {
  id: string;
  action: string;
  userId: string | null;
  username: string | null;
  role: string | null;
  metadata: unknown;
  ipAddress: string | null;
  createdAt: string;
};

type ActionCount = { action: string; count: number };

/**
 * The audit log, readable at last.
 *
 * Paging appends rather than replaces, because the useful operation here is
 * "scroll back through what happened", not "jump to page 4". The cursor comes
 * from the server so the keyset ordering stays consistent.
 */
export default function AuditLogClient() {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [actions, setActions] = useState<ActionCount[]>([]);
  const [actionFilter, setActionFilter] = useState("");
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchPage = useCallback(
    async (opts: { action: string; cursor?: string | null; append: boolean }) => {
      const params = new URLSearchParams();
      if (opts.action) params.set("action", opts.action);
      if (opts.cursor) params.set("cursor", opts.cursor);
      const res = await fetch(`/api/admin/audit?${params}`);
      const data = await res.json();
      if (!res.ok || !data.success) {
        setError(data.message ?? "Could not load the audit log.");
        return;
      }
      setEntries((prev) => (opts.append ? [...prev, ...data.entries] : data.entries));
      setActions(data.actions ?? []);
      setCursor(data.nextCursor ?? null);
      setError(null);
    },
    [],
  );

  useEffect(() => {
    // `loading` is initialised true for the first render and set true again by the
    // filter's onChange — never here. Flipping it synchronously in an effect body
    // triggers a cascading render, which is what the lint rule is protecting.
    // Async: state below is set after an await, not synchronously.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchPage({ action: actionFilter, append: false }).finally(() => setLoading(false));
  }, [actionFilter, fetchPage]);

  async function loadMore() {
    if (!cursor) return;
    setLoadingMore(true);
    try {
      await fetchPage({ action: actionFilter, cursor, append: true });
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <h1 className="section-heading">Audit log</h1>
      <p className="section-subheading mb-6">
        Every account action and every access to a student&rsquo;s personal data. Required under the DPDPA, and the
        record you would produce if anyone ever asked who looked at what.
      </p>

      {error && <p className="mb-4 text-sm text-kca-danger">{error}</p>}

      <div className="mb-4">
        <label className="mb-1 block text-xs uppercase tracking-wider text-kca-gray-400">Filter by action</label>
        <select
          className="input-field py-2 text-sm"
          value={actionFilter}
          onChange={(e) => {
            setLoading(true);
            setActionFilter(e.target.value);
          }}
        >
          <option value="">All actions</option>
          {actions.map((a) => (
            <option key={a.action} value={a.action}>
              {auditActionLabel(a.action)} ({a.count})
            </option>
          ))}
        </select>
      </div>

      {loading ? (
        <p className="text-sm text-kca-gray-400">Loading…</p>
      ) : entries.length === 0 ? (
        <div className="card text-sm text-kca-gray-400">Nothing recorded for this filter.</div>
      ) : (
        <>
          <ul className="space-y-2">
            {entries.map((e) => (
              <li key={e.id} className="card py-3">
                <button
                  type="button"
                  className="flex w-full items-start justify-between gap-3 text-left"
                  onClick={() => setExpanded(expanded === e.id ? null : e.id)}
                >
                  <span className="min-w-0">
                    <span className="block text-sm text-kca-white">{auditActionLabel(e.action)}</span>
                    <span className="block truncate text-xs text-kca-gray-400">
                      {e.username ? `${e.username}${e.role ? ` (${e.role.toLowerCase()})` : ""}` : "system"}
                      {e.ipAddress ? ` · ${e.ipAddress}` : ""}
                    </span>
                  </span>
                  <span className="shrink-0 text-xs text-kca-gray-500">
                    {new Date(e.createdAt).toLocaleString("en-IN")}
                  </span>
                </button>
                {expanded === e.id && (
                  <pre className="mt-2 overflow-x-auto rounded bg-kca-surface-2 p-2 font-mono text-xs text-kca-gray-100">
                    {JSON.stringify({ action: e.action, metadata: e.metadata }, null, 2)}
                  </pre>
                )}
              </li>
            ))}
          </ul>

          {cursor && (
            <div className="mt-4 text-center">
              <button type="button" className="btn-secondary px-4 py-2 text-sm" disabled={loadingMore} onClick={loadMore}>
                {loadingMore ? "Loading…" : "Load older"}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
