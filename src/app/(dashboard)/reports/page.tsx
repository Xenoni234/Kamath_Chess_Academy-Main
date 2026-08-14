"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, Download, FileText, Loader2, Plus, X } from "lucide-react";
import { cn } from "@/lib/utils";

type ReportStatus = "pending" | "processing" | "complete" | "failed";

type Report = {
  id: string;
  status: ReportStatus;
  lichessId: string | null;
  chesscomId: string | null;
  gamesAnalyzed: number;
  summary: string | null;
  emailSentAt: string | null;
  createdAt: string;
};

const POLL_INTERVAL_MS = 3000;
/** Reports take minutes (engine analysis + PDF + email); give up well after. */
const POLL_TIMEOUT_MS = 15 * 60 * 1000;

const STATUS_STYLES: Record<ReportStatus, string> = {
  pending: "bg-kca-gray-600/20 text-kca-gray-100 border border-kca-gray-600/30",
  processing: "bg-kca-cyan/10 text-kca-cyan border border-kca-cyan/30",
  complete: "bg-kca-success/10 text-kca-success border border-kca-success/20",
  failed: "bg-kca-danger/10 text-kca-danger border border-kca-danger/20",
};

const STATUS_LABELS: Record<ReportStatus, string> = {
  pending: "Queued",
  processing: "Analysing",
  complete: "Ready",
  failed: "Failed",
};

export default function ReportsPage() {
  const [reports, setReports] = useState<Report[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);

  const [isModalOpen, setIsModalOpen] = useState(false);
  const [lichessId, setLichessId] = useState("");
  const [chesscomId, setChesscomId] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollStartedAtRef = useRef<number>(0);

  const loadReports = useCallback(async () => {
    try {
      const response = await fetch("/api/reports");
      const data = await response.json();
      if (!response.ok || !data.success) {
        setListError(data.message ?? "Could not load your reports.");
        return [] as Report[];
      }
      setListError(null);
      setReports(data.reports ?? []);
      return (data.reports ?? []) as Report[];
    } catch {
      setListError("Could not load your reports.");
      return [] as Report[];
    }
  }, []);

  useEffect(() => {
    // `cancelled` stops the initial load from clearing the spinner after unmount.
    let cancelled = false;

    async function initialLoad() {
      await loadReports();
      if (!cancelled) setIsLoading(false);
    }

    void initialLoad();
    return () => {
      cancelled = true;
    };
  }, [loadReports]);

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  /** Poll the list while anything is still being generated. */
  const startPolling = useCallback(() => {
    stopPolling();
    pollStartedAtRef.current = Date.now();

    pollTimerRef.current = setInterval(() => {
      if (Date.now() - pollStartedAtRef.current > POLL_TIMEOUT_MS) {
        stopPolling();
        return;
      }

      void loadReports().then((next) => {
        const stillWorking = next.some(
          (report) => report.status === "pending" || report.status === "processing",
        );
        if (!stillWorking) stopPolling();
      });
    }, POLL_INTERVAL_MS);
  }, [loadReports, stopPolling]);

  // Resume polling if a report was already in flight when the page loaded.
  useEffect(() => {
    const stillWorking = reports.some(
      (report) => report.status === "pending" || report.status === "processing",
    );
    if (stillWorking && !pollTimerRef.current) startPolling();
    if (!stillWorking && pollTimerRef.current) stopPolling();
  }, [reports, startPolling, stopPolling]);

  useEffect(() => stopPolling, [stopPolling]);

  const handleGenerate = async () => {
    const lichess = lichessId.trim();
    const chesscom = chesscomId.trim();

    if (!lichess && !chesscom) {
      setFormError("Enter at least one username.");
      return;
    }

    setIsSubmitting(true);
    setFormError(null);

    try {
      const response = await fetch("/api/reports/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(lichess ? { lichessId: lichess } : {}),
          ...(chesscom ? { chesscomId: chesscom } : {}),
        }),
      });
      const data = await response.json();

      if (!response.ok || !data.success) {
        setFormError(data.message ?? "Could not start the report.");
        return;
      }

      setIsModalOpen(false);
      setLichessId("");
      setChesscomId("");
      await loadReports();
      startPolling();
    } catch {
      setFormError("Could not start the report.");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="w-full max-w-5xl mx-auto">
      <div className="mb-8 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-display font-bold text-kca-white mb-2">Game Reports</h1>
          <p className="text-sm text-kca-gray-400">
            Stockfish analyses your recent online games and your AI coach writes up what to work
            on. The finished PDF is emailed to you.
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            setFormError(null);
            setIsModalOpen(true);
          }}
          className="btn-primary py-2.5 px-5 text-sm flex items-center gap-2"
        >
          <Plus className="w-4 h-4" />
          New report
        </button>
      </div>

      <div className="card p-0 border border-kca-border bg-kca-surface rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm text-left">
            <thead className="text-xs text-kca-gray-400 bg-kca-black/50 uppercase tracking-wider border-b border-kca-border">
              <tr>
                <th className="px-6 py-4 font-semibold">Date</th>
                <th className="px-6 py-4 font-semibold">Account</th>
                <th className="px-6 py-4 font-semibold">Games</th>
                <th className="px-6 py-4 font-semibold">Status</th>
                <th className="px-6 py-4 font-semibold text-right">PDF</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-kca-border/50">
              {reports.map((report) => (
                <tr key={report.id} className="hover:bg-kca-surface-2 transition-colors align-top">
                  <td className="px-6 py-4 font-medium text-kca-white whitespace-nowrap">
                    {new Date(report.createdAt).toLocaleDateString(undefined, {
                      month: "short",
                      day: "numeric",
                      year: "numeric",
                    })}
                  </td>
                  <td className="px-6 py-4 text-kca-gray-100">
                    {report.lichessId && (
                      <span className="block font-mono text-xs">lichess: {report.lichessId}</span>
                    )}
                    {report.chesscomId && (
                      <span className="block font-mono text-xs">
                        chess.com: {report.chesscomId}
                      </span>
                    )}
                  </td>
                  <td className="px-6 py-4 font-mono text-kca-gray-100">
                    {report.gamesAnalyzed || "—"}
                  </td>
                  <td className="px-6 py-4">
                    <span
                      className={cn(
                        "inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-[10px] font-bold uppercase tracking-wider",
                        STATUS_STYLES[report.status],
                      )}
                    >
                      {(report.status === "pending" || report.status === "processing") && (
                        <Loader2 className="w-3 h-3 animate-spin" />
                      )}
                      {STATUS_LABELS[report.status]}
                    </span>
                    {report.status === "failed" && report.summary && (
                      <p className="mt-1.5 text-[11px] text-kca-gray-400 max-w-[240px]">
                        {report.summary}
                      </p>
                    )}
                  </td>
                  <td className="px-6 py-4 text-right">
                    {report.status === "complete" ? (
                      <a
                        href={`/api/reports/${report.id}/download`}
                        className="inline-flex items-center gap-1.5 text-xs text-kca-cyan hover:underline"
                      >
                        <Download className="w-4 h-4" />
                        Download
                      </a>
                    ) : (
                      <span className="text-kca-gray-600">—</span>
                    )}
                  </td>
                </tr>
              ))}

              {isLoading && (
                <tr>
                  <td colSpan={5} className="px-6 py-12 text-center text-kca-gray-500">
                    <Loader2 className="w-6 h-6 mx-auto mb-3 animate-spin text-kca-cyan" />
                    <p>Loading your reports…</p>
                  </td>
                </tr>
              )}

              {!isLoading && listError && (
                <tr>
                  <td colSpan={5} className="px-6 py-12 text-center text-kca-danger text-sm">
                    {listError}
                  </td>
                </tr>
              )}

              {!isLoading && !listError && reports.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-6 py-12 text-center text-kca-gray-500">
                    <FileText className="w-8 h-8 mx-auto mb-3 opacity-20" />
                    <p>No reports yet.</p>
                    <button
                      type="button"
                      onClick={() => setIsModalOpen(true)}
                      className="text-kca-cyan text-xs hover:underline mt-2"
                    >
                      Generate your first report
                    </button>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {isModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-kca-black/90 backdrop-blur-md p-4">
          <div className="card w-full max-w-md bg-kca-surface border border-kca-border p-6">
            <div className="flex items-start justify-between gap-4 mb-1">
              <h2 className="text-xl font-display font-bold text-kca-white">Generate a report</h2>
              <button
                type="button"
                onClick={() => setIsModalOpen(false)}
                aria-label="Close"
                className="text-kca-gray-400 hover:text-kca-white transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <p className="text-sm text-kca-gray-400 mb-5">
              Enter the online account to analyse. We read your recent public games — no password
              needed.
            </p>

            <label className="block text-[11px] uppercase tracking-wider text-kca-gray-400 mb-1.5">
              Lichess username
            </label>
            <input
              value={lichessId}
              onChange={(event) => setLichessId(event.target.value)}
              placeholder="e.g. DrNykterstein"
              className="input-field w-full mb-4"
            />

            <label className="block text-[11px] uppercase tracking-wider text-kca-gray-400 mb-1.5">
              Chess.com username
            </label>
            <input
              value={chesscomId}
              onChange={(event) => setChesscomId(event.target.value)}
              placeholder="e.g. MagnusCarlsen"
              className="input-field w-full mb-2"
            />

            <p className="text-[11px] text-kca-gray-600 mb-4">
              At least one is required. Analysis takes a few minutes — you can leave this page.
            </p>

            {formError && (
              <p className="flex items-start gap-2 text-sm text-kca-danger mb-4">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                {formError}
              </p>
            )}

            <button
              type="button"
              onClick={() => void handleGenerate()}
              disabled={isSubmitting}
              className="btn-primary w-full py-3 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isSubmitting ? (
                <span className="flex items-center justify-center gap-2">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Starting…
                </span>
              ) : (
                "Start analysis"
              )}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
