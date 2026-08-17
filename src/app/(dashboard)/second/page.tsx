"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Brain, Loader2, Plus, Trash2, X } from "lucide-react";
import { cn } from "@/lib/utils";

type ProfileStatus = "pending" | "processing" | "complete" | "failed";

type Site = "LICHESS" | "CHESSCOM";
type AccountRow = { handle: string; source: Site };

type Profile = {
  id: string;
  /** The primary account. Always present, including on pre-multi-account rows. */
  handle: string;
  source: Site;
  /** Empty on dossiers created before several accounts could be merged. */
  accounts?: { handle: string; source: Site; position: number }[];
  colorToPlay: string;
  status: ProfileStatus;
  gamesAnalyzed: number;
  createdAt: string;
};

/** Up to this many accounts per dossier — mirrors MAX_PROFILE_ACCOUNTS in zod. */
const MAX_ACCOUNTS = 5;

const SITE_LABEL: Record<Site, string> = { LICHESS: "Lichess", CHESSCOM: "Chess.com" };

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
  /** 1..5 accounts, all describing the same human. */
  const [accounts, setAccounts] = useState<AccountRow[]>([{ handle: "", source: "LICHESS" }]);
  const [colorToPlay, setColorToPlay] = useState<"white" | "black">("white");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  /** Id of the row whose delete is armed, and the one currently deleting. */
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollStartedAtRef = useRef<number>(0);

  /**
   * Deleting from the list matters most for **failed** dossiers: those rows are
   * not links, so without this they could never be removed from anywhere.
   */
  const removeProfile = useCallback(async (profileId: string) => {
    setListError(null);
    setDeletingId(profileId);
    try {
      const response = await fetch(`/api/second/profiles/${profileId}`, { method: "DELETE" });
      const data = await response.json();
      if (!response.ok || !data.success) {
        setListError(data.message ?? "Could not delete that dossier.");
        return;
      }
      // Drop it locally rather than refetching: the poller may not be running,
      // and a round trip to Tokyo to learn what we already know is wasteful.
      setProfiles((current) => current.filter((entry) => entry.id !== profileId));
    } catch {
      setListError("Could not delete that dossier.");
    } finally {
      setDeletingId(null);
      setConfirmId(null);
    }
  }, []);

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

  const updateAccount = useCallback((index: number, patch: Partial<AccountRow>) => {
    setAccounts((current) =>
      current.map((account, i) => (i === index ? { ...account, ...patch } : account)),
    );
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();

    const filled = accounts
      .map((a) => ({ ...a, handle: a.handle.trim() }))
      .filter((a) => a.handle.length > 0);

    if (filled.length === 0) {
      setFormError("Enter at least one username.");
      return;
    }
    // Mirrors the server's case-insensitive refine, so the common mistake is
    // caught before a job is queued rather than after a 400.
    const keys = filled.map((a) => `${a.source}:${a.handle.toLowerCase()}`);
    if (new Set(keys).size !== keys.length) {
      setFormError("The same account is listed twice.");
      return;
    }

    setIsSubmitting(true);
    setFormError(null);
    try {
      const response = await fetch("/api/second/profiles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accounts: filled, colorToPlay }),
      });
      const data = await response.json();
      if (!response.ok || !data.success) {
        setFormError(data.message ?? "Could not start profiling.");
        return;
      }
      setIsModalOpen(false);
      setAccounts([{ handle: "", source: "LICHESS" }]);
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
            // A running job writes back to this row after it finishes, so
            // deleting mid-flight would resurrect most of what we removed.
            const busy = p.status === "pending" || p.status === "processing";
            const armed = confirmId === p.id;
            const deleting = deletingId === p.id;

            const card = (
              <div
                className={cn(
                  "card h-full p-5 border border-kca-border bg-kca-surface flex items-center justify-between gap-4",
                  ready && "hover:border-kca-cyan/50 transition-colors",
                )}
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-lg font-semibold text-kca-white">{p.handle}</span>
                    {(p.accounts?.length ?? 0) > 1 && (
                      <span className="rounded-full border border-kca-border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-kca-gray-400">
                        +{p.accounts!.length - 1} more
                      </span>
                    )}
                  </div>
                  <div className="text-sm text-kca-gray-400 mt-1">
                    {/* Pre-multi-account rows have no `accounts`, so fall back
                        to the denormalised primary rather than showing nothing. */}
                    {p.accounts?.length
                      ? [...new Set(p.accounts.map((a) => SITE_LABEL[a.source]))].join(" + ")
                      : SITE_LABEL[p.source]}{" "}
                    · you play {p.colorToPlay}
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

            // The delete button is a *sibling* of the link, never a child —
            // a button inside an anchor is invalid and swallows the click.
            return (
              <div key={p.id} className="flex items-stretch gap-2">
                {ready ? (
                  <Link href={`/dashboard/second/${p.id}`} className="block min-w-0 flex-1">
                    {card}
                  </Link>
                ) : (
                  <div className="min-w-0 flex-1">{card}</div>
                )}
                <button
                  type="button"
                  onClick={() => (armed ? void removeProfile(p.id) : setConfirmId(p.id))}
                  onBlur={() => setConfirmId((current) => (current === p.id ? null : current))}
                  disabled={busy || deleting}
                  aria-label={armed ? `Confirm deleting ${p.handle}` : `Delete ${p.handle}`}
                  title={
                    busy
                      ? "Wait for profiling to finish before deleting"
                      : armed
                        ? "Click again to permanently delete — this cannot be undone"
                        : "Delete this dossier"
                  }
                  className={cn(
                    "card shrink-0 border bg-kca-surface px-4 transition-colors disabled:opacity-40",
                    armed
                      ? "border-kca-danger/60 text-kca-danger"
                      : "border-kca-border text-kca-gray-400 hover:border-kca-danger/40 hover:text-kca-danger",
                  )}
                >
                  {deleting ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : armed ? (
                    <span className="text-xs font-semibold whitespace-nowrap">Confirm?</span>
                  ) : (
                    <Trash2 className="h-4 w-4" />
                  )}
                </button>
              </div>
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
                  Their accounts
                </label>
                <div className="space-y-2">
                  {accounts.map((account, index) => (
                    <div key={index} className="flex items-center gap-2">
                      <select
                        className="input-field w-32 shrink-0 py-2 text-sm"
                        value={account.source}
                        onChange={(e) => updateAccount(index, { source: e.target.value as Site })}
                        aria-label={`Site for account ${index + 1}`}
                      >
                        <option value="LICHESS">Lichess</option>
                        <option value="CHESSCOM">Chess.com</option>
                      </select>
                      <input
                        className="input-field min-w-0 flex-1 py-2 text-sm"
                        value={account.handle}
                        onChange={(e) => updateAccount(index, { handle: e.target.value })}
                        placeholder={index === 0 ? "e.g. DrNykterstein" : "Another account"}
                        aria-label={`Username for account ${index + 1}`}
                        autoFocus={index === 0}
                      />
                      {accounts.length > 1 && (
                        <button
                          type="button"
                          onClick={() => setAccounts((c) => c.filter((_, i) => i !== index))}
                          className="shrink-0 rounded-lg p-2 text-kca-gray-400 hover:text-kca-danger"
                          aria-label={`Remove account ${index + 1}`}
                        >
                          <X className="h-4 w-4" />
                        </button>
                      )}
                    </div>
                  ))}
                </div>

                {accounts.length < MAX_ACCOUNTS && (
                  <button
                    type="button"
                    onClick={() => setAccounts((c) => [...c, { handle: "", source: "LICHESS" }])}
                    className="mt-2 inline-flex items-center gap-1.5 text-xs font-semibold text-kca-cyan hover:underline"
                  >
                    <Plus className="h-3.5 w-3.5" /> Add another account
                  </button>
                )}

                <p className="mt-2 text-xs text-kca-gray-500">
                  Add every account the same player uses — up to {MAX_ACCOUNTS}, across both sites.
                  Their games are merged into one dossier, so a player who plays rapid on Lichess
                  and blitz on Chess.com is profiled from all of it. FIDE has no public game
                  database, so preparation needs at least one online account.
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
