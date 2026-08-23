"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Brain, Loader2, Plus, Trash2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { SOURCE_LABEL } from "@/lib/second/types";
import { MAX_PASTED_GAMES } from "@/lib/validations/phase4";
import type { OpponentSource } from "@/lib/second/types";

type ProfileStatus = "pending" | "processing" | "complete" | "failed";

/** Sources the create form lets you pick a handle for. MANUAL/BROADCAST
 * arrive through paste / FIDE, not this dropdown. */
type Site = "LICHESS" | "CHESSCOM";
type AccountRow = { handle: string; source: Site };

type Profile = {
  id: string;
  /** The primary account. Always present, including on pre-multi-account rows. */
  handle: string;
  source: OpponentSource;
  /** Empty on dossiers created before several accounts could be merged. */
  accounts?: { handle: string; source: OpponentSource; position: number }[];
  colorToPlay: string;
  status: ProfileStatus;
  gamesAnalyzed: number;
  createdAt: string;
};

/** Up to this many accounts per dossier — mirrors MAX_PROFILE_ACCOUNTS in zod. */
const MAX_ACCOUNTS = 5;


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

type PreviewGame = {
  index: number;
  opponentColor: "w" | "b";
  result: "won" | "drawn" | "lost";
  date: string | null;
  moveCount: number;
  opening: string;
  eco: string | null;
  opponentName: string | null;
};
type PreviewReject = { index: number; label: string; reason: string };
type PgnPreview = { accepted: PreviewGame[]; rejected: PreviewReject[]; total: number };

export default function SecondPage() {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);

  const [isModalOpen, setIsModalOpen] = useState(false);
  /** 1..5 accounts, all describing the same human. */
  const [accounts, setAccounts] = useState<AccountRow[]>([{ handle: "", source: "LICHESS" }]);
  const [colorToPlay, setColorToPlay] = useState<"white" | "black">("white");
  const [fideId, setFideId] = useState("");
  const [playerName, setPlayerName] = useState("");
  const [pastedPgn, setPastedPgn] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  /** Live paste preview: which games parse, and why the rest don't. */
  const [pgnPreview, setPgnPreview] = useState<PgnPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  /** UI override for the opponent's colour when names match neither side. */
  const [forcedColor, setForcedColor] = useState<"" | "w" | "b">("");
  const previewTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  // Debounced live preview of the pasted PGN — same parser the job uses, so what
  // the user sees is exactly what will be ingested.
  useEffect(() => {
    if (previewTimer.current) clearTimeout(previewTimer.current);
    const text = pastedPgn.trim();
    if (!text) {
      setPgnPreview(null);
      setPreviewLoading(false);
      return;
    }
    setPreviewLoading(true);
    previewTimer.current = setTimeout(async () => {
      try {
        const res = await fetch("/api/second/pgn-preview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            pastedPgn: text,
            playerName: playerName.trim() || undefined,
            fideId: fideId.trim() || undefined,
            forcedColor: forcedColor || undefined,
          }),
        });
        const data = await res.json();
        setPgnPreview(data.success ? { accepted: data.accepted, rejected: data.rejected, total: data.total } : null);
      } catch {
        setPgnPreview(null);
      } finally {
        setPreviewLoading(false);
      }
    }, 400);
    return () => {
      if (previewTimer.current) clearTimeout(previewTimer.current);
    };
  }, [pastedPgn, playerName, fideId, forcedColor]);

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

    const pasted = pastedPgn.trim();
    if (pasted) {
      if (!playerName.trim() && !fideId.trim() && !forcedColor) {
        setFormError("Add the opponent's name or FIDE ID (or set which colour they played) so we know which side is theirs.");
        return;
      }
      // The live preview is authoritative when it has loaded; otherwise fall back
      // to the raw [Event tally as a last-resort cap guard.
      if (pgnPreview) {
        if (pgnPreview.accepted.length === 0) {
          setFormError("None of the pasted games can be used yet — check the preview below.");
          return;
        }
      } else {
        const gameCount = (pasted.match(/\[Event\b/gi) ?? []).length || 1;
        if (gameCount > MAX_PASTED_GAMES) {
          setFormError(`Paste at most ${MAX_PASTED_GAMES} games (found ${gameCount}).`);
          return;
        }
      }
    }

    setIsSubmitting(true);
    setFormError(null);
    try {
      const response = await fetch("/api/second/profiles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accounts: filled,
          colorToPlay,
          fideId: fideId.trim() || undefined,
          playerName: playerName.trim() || undefined,
          pastedPgn: pasted || undefined,
          forcedColor: (pasted && forcedColor) || undefined,
        }),
      });
      const data = await response.json();
      if (!response.ok || !data.success) {
        setFormError(data.message ?? "Could not start profiling.");
        return;
      }
      setIsModalOpen(false);
      setAccounts([{ handle: "", source: "LICHESS" }]);
      setFideId("");
      setPlayerName("");
      setPastedPgn("");
      setPgnPreview(null);
      setForcedColor("");
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
                      ? [...new Set(p.accounts.map((a) => SOURCE_LABEL[a.source]))].join(" + ")
                      : SOURCE_LABEL[p.source]}{" "}
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
          <div className="card max-h-[90vh] w-full max-w-md overflow-y-auto border border-kca-border bg-kca-surface p-6">
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
                    <div
                      key={index}
                      className="grid grid-cols-[7.5rem_minmax(0,1fr)_auto] items-center gap-2"
                    >
                      <select
                        className="input-field py-2 text-sm"
                        value={account.source}
                        onChange={(e) => updateAccount(index, { source: e.target.value as Site })}
                        aria-label={`Site for account ${index + 1}`}
                      >
                        <option value="LICHESS">Lichess</option>
                        <option value="CHESSCOM">Chess.com</option>
                      </select>
                      <input
                        className="input-field py-2 text-sm"
                        value={account.handle}
                        onChange={(e) => updateAccount(index, { handle: e.target.value })}
                        placeholder={index === 0 ? "their username" : "another username"}
                        aria-label={`Username for account ${index + 1}`}
                        autoFocus={index === 0}
                      />
                      {accounts.length > 1 ? (
                        <button
                          type="button"
                          onClick={() => setAccounts((c) => c.filter((_, i) => i !== index))}
                          className="rounded-lg p-2 text-kca-gray-400 hover:text-kca-danger"
                          aria-label={`Remove account ${index + 1}`}
                        >
                          <X className="h-4 w-4" />
                        </button>
                      ) : (
                        <span className="w-8" aria-hidden />
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
                  and blitz on Chess.com is profiled from all of it. At least one online account is
                  required; the two options below add to it.
                </p>
              </div>

              <div>
                <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-kca-gray-400">
                  FIDE ID — over-the-board games (optional)
                </label>
                <input
                  className="input-field py-2 text-sm"
                  value={fideId}
                  onChange={(e) => setFideId(e.target.value.replace(/\D/g, ""))}
                  inputMode="numeric"
                  placeholder="e.g. 46608524"
                  aria-label="FIDE ID"
                />
                <p className="mt-1.5 text-xs text-kca-gray-500">
                  Pulls their real tournament games from Lichess broadcasts, matched exactly by FIDE
                  ID. Leave blank to skip.
                </p>
              </div>

              <div>
                <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-kca-gray-400">
                  Opponent&rsquo;s name (for pasted / OTB games)
                </label>
                <input
                  className="input-field py-2 text-sm"
                  value={playerName}
                  onChange={(e) => setPlayerName(e.target.value)}
                  placeholder="e.g. Kapadi Yash"
                  aria-label="Opponent's name"
                />
              </div>

              <div>
                <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-kca-gray-400">
                  Paste games (optional, up to {MAX_PASTED_GAMES})
                </label>
                <textarea
                  className="input-field min-h-[7rem] resize-y py-2 font-mono text-xs leading-relaxed"
                  value={pastedPgn}
                  onChange={(e) => setPastedPgn(e.target.value)}
                  placeholder={"[Event \"...\"]\n[White \"...\"]\n[Black \"...\"]\n1. e4 e5 ..."}
                  aria-label="Paste PGN games"
                  spellCheck={false}
                />
                <p className="mt-1.5 text-xs text-kca-gray-500">
                  Paste one or more games in PGN. Each game needs a date, and the opponent&rsquo;s
                  name (above) or FIDE ID so we know which side is theirs.
                </p>

                {previewLoading && !pgnPreview && (
                  <p className="mt-2 text-xs text-kca-gray-400">Checking games…</p>
                )}

                {pgnPreview && (
                  <div className="mt-2 rounded-lg border border-kca-border bg-kca-surface-2 p-3">
                    <div className="flex items-center justify-between">
                      <p className="text-xs font-semibold text-kca-white">
                        {pgnPreview.accepted.length} of {pgnPreview.total} game
                        {pgnPreview.total === 1 ? "" : "s"} ready
                        {pgnPreview.rejected.length > 0 && (
                          <span className="text-kca-warning"> · {pgnPreview.rejected.length} skipped</span>
                        )}
                      </p>
                      {previewLoading && <span className="text-xs text-kca-gray-500">updating…</span>}
                    </div>

                    {pgnPreview.rejected.some((r) => /which side/i.test(r.reason)) && (
                      <div className="mt-2 rounded-md border border-kca-warning/40 bg-kca-warning/10 p-2 text-xs text-kca-gray-100">
                        Some games don&rsquo;t name the opponent in a way we can match. If every pasted
                        game is the same opponent, set which colour they played:
                        <div className="mt-1.5 flex gap-1.5">
                          {(["w", "b"] as const).map((c) => (
                            <button
                              key={c}
                              type="button"
                              onClick={() => setForcedColor((prev) => (prev === c ? "" : c))}
                              className={`rounded px-2 py-1 ${
                                forcedColor === c
                                  ? "bg-kca-cyan text-black"
                                  : "border border-kca-border bg-kca-surface-3 text-kca-gray-100"
                              }`}
                            >
                              Opponent played {c === "w" ? "White" : "Black"}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}

                    {pgnPreview.accepted.length > 0 && (
                      <ul className="mt-2 max-h-40 space-y-1 overflow-auto">
                        {pgnPreview.accepted.map((g) => (
                          <li key={`a-${g.index}`} className="flex items-center gap-2 text-xs text-kca-gray-100">
                            <span
                              className={`inline-block h-2 w-2 shrink-0 rounded-full ${
                                g.result === "won"
                                  ? "bg-kca-success"
                                  : g.result === "lost"
                                    ? "bg-kca-danger"
                                    : "bg-kca-gray-400"
                              }`}
                            />
                            <span className="font-mono text-kca-gray-400">{g.date ?? "no date"}</span>
                            <span>as {g.opponentColor === "w" ? "White" : "Black"}</span>
                            <span className="text-kca-gray-500">· {g.result}</span>
                            {g.opponentName && <span className="truncate text-kca-gray-500">vs {g.opponentName}</span>}
                            <span className="ml-auto shrink-0 text-kca-gray-500">{g.moveCount} moves</span>
                          </li>
                        ))}
                      </ul>
                    )}

                    {pgnPreview.rejected.length > 0 && (
                      <ul className="mt-2 space-y-1 border-t border-kca-border pt-2">
                        {pgnPreview.rejected.map((r, i) => (
                          <li key={`r-${i}`} className="flex gap-2 text-xs">
                            <span className="shrink-0 text-kca-danger">skipped</span>
                            <span className="truncate text-kca-gray-400">{r.label}</span>
                            <span className="text-kca-gray-500">— {r.reason}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}

                {pastedPgn.trim() && !playerName.trim() && !fideId.trim() && !forcedColor && (
                  <p className="mt-1.5 text-xs text-kca-warning">
                    Add the opponent&rsquo;s name or FIDE ID above so we know which side is theirs.
                  </p>
                )}
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
