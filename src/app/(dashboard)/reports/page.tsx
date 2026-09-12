"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, Download, Eye, FileText, Loader2, Plus, Trash2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { fetchWithAuth } from "@/lib/http/fetchWithAuth";

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

/**
 * Must outlast the JOB, not merely "minutes". The engine budget alone is 15 minutes
 * (REPORT_BUDGET.totalTimeoutMs) and the narrative and PDF come after it, so a 15-minute
 * poll timeout could stop updating while the report was still being built — the page would
 * sit on "Analysing" forever and a finished report would only appear on a reload. That is
 * the same mismatch already fixed on the dossier page; keep this comfortably above the job.
 * Raised again when the deep self-profile landed: a report can now run ~25 minutes, so a
 * 25-minute poll would stop at exactly the wrong moment.
 */
const POLL_TIMEOUT_MS = 40 * 60 * 1000;

/**
 * What a report actually costs on the 2-vCPU production box. Two engine passes: the
 * accuracy pass over up to 60 games and then the deep self-profile — the same stages the
 * opponent dossier runs, over both colours.
 *
 * MEASURED, not estimated: the first production run took ~15 minutes at a 2400-position
 * budget. That budget is now 4000, so the first pass grows by about two thirds.
 * Under-promising here is not kindness — a student watching a counter pass the number we
 * gave them assumes it has hung.
 */
const TYPICAL_BUILD_LABEL = "usually 15-25 minutes";

/** "42s", "3m 05s" — how long this report has been building. */
function elapsedLabel(startIso: string, nowMs: number) {
  const seconds = Math.max(0, Math.round((nowMs - new Date(startIso).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

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
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);

  const [isModalOpen, setIsModalOpen] = useState(false);
  const [lichessId, setLichessId] = useState("");
  const [chesscomId, setChesscomId] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Ticks once a second so the elapsed time on a building report actually moves — the
  // three-second poll alone made it jump. Stops entirely when nothing is building, so an
  // idle list is not re-rendering forever.
  const [nowMs, setNowMs] = useState(() => Date.now());
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollStartedAtRef = useRef<number>(0);

  const loadReports = useCallback(async () => {
    try {
      // `fetchWithAuth`, not `fetch`: this page polls for up to 40 minutes while a report
      // builds and the access token lives 15, so a long build WILL cross an expiry. That
      // surfaced as a red "Unauthorized" sitting over a report that was building fine.
      const response = await fetchWithAuth("/api/reports");
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

  // Drive the elapsed clock only while something is actually building.
  const isBuilding = reports.some(
    (report) => report.status === "pending" || report.status === "processing",
  );
  useEffect(() => {
    if (!isBuilding) return;
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [isBuilding]);

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
      const response = await fetchWithAuth("/api/reports/generate", {
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

  /**
   * Delete a report. Removed from the list straight away, and put back if the server says
   * no — a student should not have to wonder whether the tap registered.
   */
  const deleteReport = async (id: string) => {
    if (!confirm("Delete this report? You can always make a new one.")) return;

    const previous = reports;
    setDeletingId(id);
    setReports((rows) => rows.filter((r) => r.id !== id));

    try {
      const res = await fetchWithAuth(`/api/reports/${id}`, { method: "DELETE" });
      if (!res.ok) setReports(previous);
    } catch {
      setReports(previous);
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="w-full max-w-5xl mx-auto">
      <div className="mb-8 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-display font-bold text-kca-white mb-2">Game Reports</h1>
          <p className="text-sm text-kca-gray-400">
            We look at your recent online games and write down what to practise. Your report
            stays here — open it or save it whenever you like.
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
                <th className="px-6 py-4 font-semibold text-right">Report</th>
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
                    {(report.status === "pending" || report.status === "processing") && (
                      <p className="mt-1.5 text-[11px] text-kca-gray-400">
                        {elapsedLabel(report.createdAt, nowMs)} · {TYPICAL_BUILD_LABEL}
                      </p>
                    )}
                    {report.status === "failed" && report.summary && (
                      <p className="mt-1.5 text-[11px] text-kca-gray-400 max-w-[240px]">
                        {report.summary}
                      </p>
                    )}
                  </td>
                  <td className="px-6 py-4 text-right">
                    {report.status === "complete" ? (
                      <div className="inline-flex items-center gap-4">
                        {/* Opening it should not require saving a file first. */}
                        <a
                          href={`/api/reports/${report.id}/download?view=1`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1.5 text-xs text-kca-cyan hover:underline"
                        >
                          <Eye className="w-4 h-4" />
                          Open
                        </a>
                        <a
                          href={`/api/reports/${report.id}/download`}
                          className="inline-flex items-center gap-1.5 text-xs text-kca-cyan hover:underline"
                        >
                          <Download className="w-4 h-4" />
                          Save
                        </a>
                        <button
                          type="button"
                          onClick={() => void deleteReport(report.id)}
                          disabled={deletingId === report.id}
                          title="Delete this report"
                          className="inline-flex items-center gap-1.5 text-xs text-kca-gray-400 hover:text-kca-danger disabled:opacity-50"
                        >
                          <Trash2 className="w-4 h-4" />
                          Delete
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => void deleteReport(report.id)}
                        disabled={deletingId === report.id}
                        title="Delete this report"
                        className="inline-flex items-center gap-1.5 text-xs text-kca-gray-400 hover:text-kca-danger disabled:opacity-50"
                      >
                        <Trash2 className="w-4 h-4" />
                        Delete
                      </button>
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
              At least one is required. We look at up to 60 of your recent games and work out
              your strengths and weaknesses as White and as Black, which takes{" "}
              {TYPICAL_BUILD_LABEL.replace("usually ", "")} — you can leave this page and we will
              tell you when it is ready.
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
