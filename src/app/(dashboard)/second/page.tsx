"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Brain, Loader2, Plus, X } from "lucide-react";
import { cn } from "@/lib/utils";

type ProfileStatus = "pending" | "processing" | "complete" | "failed";

type Profile = {
  id: string;
  handle: string;
  source: "LICHESS" | "CHESSCOM";
  colorToPlay: string;
  status: ProfileStatus;
  gamesAnalyzed: number;
  createdAt: string;
};

const POLL_INTERVAL_MS = 4000;
/** Profiling runs engine analysis over many positions; allow a long window. */
const POLL_TIMEOUT_MS = 20 * 60 * 1000;

const STATUS_STYLES: Record<ProfileStatus, string> = {
  pending: "bg-kca-gray-600/20 text-kca-gray-100 border border-kca-gray-600/30",
  processing: "bg-kca-cyan/10 text-kca-cyan border border-kca-cyan/30",
  complete: "bg-kca-success/10 text-kca-success border border-kca-success/20",
  failed: "bg-kca-danger/10 text-kca-danger border border-kca-danger/20",
};

const STATUS_LABELS: Record<ProfileStatus, string> = {
  pending: "Queued",
  processing: "Profiling",
  complete: "Ready",
  failed: "Failed",
};

export default function SecondPage() {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);

  const [isModalOpen, setIsModalOpen] = useState(false);
  const [handle, setHandle] = useState("");
  const [source, setSource] = useState<"LICHESS" | "CHESSCOM">("LICHESS");
  const [colorToPlay, setColorToPlay] = useState<"white" | "black">("white");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollStartedAtRef = useRef<number>(0);

  const loadProfiles = useCallback(async () => {
    try {
      const response = await fetch("/api/second/profiles");
      const data = await response.json();
      if (!response.ok || !data.success) {
        setListError(data.message ?? "Could not load your dossiers.");
        return [] as Profile[];
      }
      setListError(null);
      setProfiles(data.profiles);
      return data.profiles as Profile[];
    } catch {
      setListError("Could not load your dossiers.");
      return [] as Profile[];
    } finally {
      setIsLoading(false);
    }
  }, []);

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  const startPolling = useCallback(() => {
    if (pollTimerRef.current) return;
    pollStartedAtRef.current = Date.now();
    pollTimerRef.current = setInterval(async () => {
      const latest = await loadProfiles();
      const pending = latest.some((p) => p.status === "pending" || p.status === "processing");
      if (!pending || Date.now() - pollStartedAtRef.current > POLL_TIMEOUT_MS) {
        stopPolling();
      }
    }, POLL_INTERVAL_MS);
  }, [loadProfiles, stopPolling]);

  useEffect(() => {
    // Kick the initial load off the effect body so the first paint isn't
    // blocked by a synchronous setState cascade.
    let cancelled = false;
    void (async () => {
      const latest = await loadProfiles();
      if (cancelled) return;
      if (latest.some((p) => p.status === "pending" || p.status === "processing")) startPolling();
    })();
    return () => {
      cancelled = true;
      stopPolling();
    };
  }, [loadProfiles, startPolling, stopPolling]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!handle.trim()) {
      setFormError("Enter the opponent's username.");
      return;
    }
    setIsSubmitting(true);
    setFormError(null);
    try {
      const response = await fetch("/api/second/profiles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ handle: handle.trim(), source, colorToPlay }),
      });
      const data = await response.json();
      if (!response.ok || !data.success) {
        setFormError(data.message ?? "Could not start profiling.");
        return;
      }
      setIsModalOpen(false);
      setHandle("");
      await loadProfiles();
      startPolling();
    } catch {
      setFormError("Could not start profiling.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="w-full max-w-4xl mx-auto">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-display font-bold text-kca-white mb-2">Digital Second</h1>
          <p className="text-sm text-kca-gray-400 max-w-xl">
            Profile an opponent from their online games: their repertoire, where they are weak,
            move-orders that dodge their prep, and an annotated repertoire built for that player.
          </p>
        </div>
        <button onClick={() => setIsModalOpen(true)} className="btn-primary py-2 px-4 shrink-0">
          <Plus className="w-4 h-4" /> New dossier
        </button>
      </div>

      {listError && (
        <div className="mb-4 rounded-lg border border-kca-danger/30 bg-kca-danger/10 px-4 py-3 text-sm text-kca-danger">
          {listError}
        </div>
      )}

      {isLoading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="w-6 h-6 animate-spin text-kca-cyan" />
        </div>
      ) : profiles.length === 0 ? (
        <div className="card p-10 text-center text-kca-gray-400 border border-kca-border bg-kca-surface">
          <Brain className="w-8 h-8 mx-auto mb-3 opacity-20" />
          <p>No dossiers yet. Profile an opponent to get started.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {profiles.map((p) => {
            const ready = p.status === "complete";
            const card = (
              <div
                className={cn(
                  "card p-5 border border-kca-border bg-kca-surface flex items-center justify-between gap-4",
                  ready && "hover:border-kca-cyan/50 transition-colors",
                )}
              >
                <div>
                  <div className="text-lg font-semibold text-kca-white">{p.handle}</div>
                  <div className="text-sm text-kca-gray-400 mt-1">
                    {p.source === "LICHESS" ? "Lichess" : "Chess.com"} · you play {p.colorToPlay}
                    {p.gamesAnalyzed > 0 && ` · ${p.gamesAnalyzed} games`} ·{" "}
                    {new Date(p.createdAt).toLocaleString()}
                  </div>
                </div>
                <span
                  className={cn(
                    "shrink-0 rounded-full px-3 py-1 text-[10px] font-bold uppercase tracking-wider",
                    STATUS_STYLES[p.status],
                  )}
                >
                  {STATUS_LABELS[p.status]}
                </span>
              </div>
            );
            return ready ? (
              <Link key={p.id} href={`/dashboard/second/${p.id}`} className="block">
                {card}
              </Link>
            ) : (
              <div key={p.id}>{card}</div>
            );
          })}
        </div>
      )}

      {isModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="card w-full max-w-md border border-kca-border bg-kca-surface p-6">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-xl font-display font-bold text-kca-white">Profile an opponent</h2>
              <button onClick={() => setIsModalOpen(false)} className="text-kca-gray-400 hover:text-kca-white">
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={submit} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-kca-gray-400 mb-1.5">
                  Site
                </label>
                <select
                  className="input-field py-2 text-sm"
                  value={source}
                  onChange={(e) => setSource(e.target.value as typeof source)}
                >
                  <option value="LICHESS">Lichess</option>
                  <option value="CHESSCOM">Chess.com</option>
                </select>
              </div>

              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-kca-gray-400 mb-1.5">
                  Their username
                </label>
                <input
                  className="input-field py-2 text-sm"
                  value={handle}
                  onChange={(e) => setHandle(e.target.value)}
                  placeholder="e.g. DrNykterstein"
                  autoFocus
                />
                <p className="mt-1.5 text-xs text-kca-gray-500">
                  FIDE has no public game database, so preparation needs a Lichess or Chess.com
                  account.
                </p>
              </div>

              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-kca-gray-400 mb-1.5">
                  You play
                </label>
                <select
                  className="input-field py-2 text-sm"
                  value={colorToPlay}
                  onChange={(e) => setColorToPlay(e.target.value as typeof colorToPlay)}
                >
                  <option value="white">White</option>
                  <option value="black">Black</option>
                </select>
              </div>

              {formError && <p className="text-sm text-kca-danger">{formError}</p>}

              <button type="submit" disabled={isSubmitting} className="btn-primary w-full py-2.5 disabled:opacity-50">
                {isSubmitting ? <Loader2 className="w-4 h-4 animate-spin" /> : "Build dossier"}
              </button>
              <p className="text-center text-xs text-kca-gray-500">
                Profiling runs engine analysis over their games — this takes a few minutes.
              </p>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
