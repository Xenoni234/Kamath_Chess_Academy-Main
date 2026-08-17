"use client";

import { use, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Activity,
  ArrowLeft,
  BookOpen,
  Download,
  Layers,
  Loader2,
  Play,
  RefreshCw,
  Shuffle,
  Sparkles,
  Swords,
  Target,
  Trash2,
} from "lucide-react";
import { cn } from "@/lib/utils";

const POLL_INTERVAL_MS = 4000;
/** Profiling runs engine analysis over many positions; allow a long window. */
const POLL_TIMEOUT_MS = 20 * 60 * 1000;

/**
 * `graphUsed: false` means the transposition pass did not run, but it does not
 * say why — and the old copy always blamed configuration, which sent you off
 * checking env vars even when Neo4j was healthy and the stage had simply
 * thrown. Dossiers generated before `graphSkipReason` existed carry no reason
 * at all, so that case says so instead of guessing.
 */
function graphSkipMessage(reason: Artifact["graphSkipReason"]): string {
  if (reason === "not-configured") {
    return "Transposition analysis did not run — the graph database was not configured when this dossier was generated. Regenerate to retry.";
  }
  if (reason === "failed") {
    return "Transposition analysis failed while this dossier was generated. Check the server log for “[second] Neo4j transposition stage failed”, then regenerate.";
  }
  return "Transposition analysis is unavailable for this dossier. Regenerate to retry with the current setup.";
}

type Weakness = {
  line: string[];
  theirMove: string;
  accuracy: number;
  avgClockSpent: number | null;
  weightedFrequency: number;
  weaknessScore: number;
};
type Novelty = { line: string[]; move: string; evalCp: number | null; explorerShare: number | null };
type Transposition = {
  bypass: string[];
  mainLine: string[];
  note: string;
  /** `bypass` played out to a usable depth. Absent on older dossiers. */
  extended?: string[];
  outOfBookAtPly?: number;
};
type RepLine = {
  moves: string[];
  rationale: string;
  tag: string;
  /** Ply where the opponent leaves their own book; engine guesswork after this. */
  outOfBookAtPly?: number;
  evalCp?: number | null;
};

/** Per-account provenance. Absent on dossiers built before accounts could merge. */
type ArtifactAccount = {
  handle: string;
  source: "LICHESS" | "CHESSCOM";
  gamesFetched: number;
  gamesUsed: number;
  oldestPlayedAt: string | null;
  newestPlayedAt: string | null;
  meanWeight: number;
  status: "ok" | "not-found" | "rate-limited" | "error";
};

type IngestDiagnostics = {
  totalFetched: number;
  duplicatesDropped: number;
  selfPlayDropped: number;
  noTimestampDropped: number;
  budgetTrimmed: number;
  clocksDiscardedMisaligned: number;
  budgetReduced?: boolean;
};

type MotifStat = {
  motif: string;
  opportunities: number;
  found: number;
  missed: number;
  missRate: number;
  missRateLow: number;
  missRateHigh: number;
  detectorPrecision: number;
};

/** Absent on dossiers generated before tactical profiling existed. */
type TacticalProfile = {
  gamesScanned: number;
  positionsScanned: number;
  motifs: MotifStat[];
  minOpportunities: number;
};

const MOTIF_LABEL: Record<string, string> = {
  fork: "Forks",
  skewer: "Skewers",
  discoveredAttack: "Discovered attacks",
  hangingPiece: "Loose pieces",
  backRankMate: "Back-rank mates",
  pin: "Pins",
};

type BehaviourBucket = {
  label: string;
  n: number;
  accuracy: number;
  accuracyLow: number;
  accuracyHigh: number;
  blunderRate: number;
};

/** Absent on dossiers generated before behavioural profiling existed. */
type BehaviouralProfile = {
  gamesScanned: number;
  movesGraded: number;
  minSamples: number;
  clockDataAvailable: boolean;
  timePressure: BehaviourBucket[];
  longThink: BehaviourBucket[];
  tilt: BehaviourBucket[];
  structures: BehaviourBucket[];
  lossesAnalyzed: number;
  terminations: { termination: string; label: string; count: number; share: number }[];
};

type Artifact = {
  handle: string;
  source: string;
  tactical?: TacticalProfile;
  behaviour?: BehaviouralProfile;
  /** Absent on older, single-account dossiers. */
  accounts?: ArtifactAccount[];
  ingest?: IngestDiagnostics;
  recencyReferenceAt?: string;
  /**
   * Absent on dossiers generated before think time was increment-corrected. On
   * those, every clock figure is understated by the increment.
   */
  clockBasis?: { initialSec: number | null; gamesUsed: number; gamesExcluded: number };
  colorToPlay: string;
  gamesAnalyzed: number;
  /** `handle`/`source` absent on older dossiers, where two accounts on the same
   *  format collided into one entry. */
  ratingSummary: {
    format: string;
    rating: number | null;
    handle?: string;
    source?: "LICHESS" | "CHESSCOM";
  }[];
  trieSummary: { line: string[]; weightedCount: number; scorePct: number }[];
  weaknesses: Weakness[];
  transpositions: Transposition[];
  novelties: Novelty[];
  graphUsed: boolean;
  /** Absent on dossiers generated before the reason was recorded. */
  graphSkipReason?: "not-configured" | "failed";
};

type Profile = {
  id: string;
  handle: string;
  source: string;
  colorToPlay: string;
  fideId: string | null;
  status: string;
  gamesAnalyzed: number;
  artifact: Artifact | null;
  summary: string | null;
  createdAt: string;
  repertoire: { id: string; summary: string; lines: RepLine[]; hasPdf: boolean } | null;
};

const TAG_STYLES: Record<string, string> = {
  novelty: "bg-kca-cyan/10 text-kca-cyan border-kca-cyan/30",
  weakness: "bg-kca-danger/10 text-kca-danger border-kca-danger/30",
  transposition: "bg-kca-warning/10 text-kca-warning border-kca-warning/30",
  mainline: "bg-kca-gray-600/20 text-kca-gray-100 border-kca-gray-600/30",
};

/** Numbered PGN movetext — what the analysis board's ?pgn= loader expects. */
function toPgn(moves: string[]): string {
  let out = "";
  for (let i = 0; i < moves.length; i += 1) {
    if (i % 2 === 0) out += `${i / 2 + 1}. `;
    out += `${moves[i]} `;
  }
  return out.trim();
}

/**
 * A move-order, clickable through to the analysis board so the line can be
 * played out with the engine rather than just read as text.
 */
/**
 * A full variation: numbered movetext that wraps, with everything past the
 * opponent's book greyed out.
 *
 * That distinction is the point of the panel — up to `outOfBookAtPly` these are
 * moves this opponent has actually played, after it they are the engine's best
 * guess. Rendering both in the same colour would imply a confidence the second
 * half does not have.
 */
function LineMoves({ moves, outOfBookAtPly }: { moves: string[]; outOfBookAtPly?: number }) {
  if (moves.length === 0) return <span className="text-kca-gray-500">(starting position)</span>;

  const bookEndsAtMove =
    outOfBookAtPly === undefined ? null : Math.floor(outOfBookAtPly / 2) + 1;

  return (
    <div className="min-w-0 space-y-1">
      <Link
        href={`/dashboard/analysis?pgn=${encodeURIComponent(toPgn(moves))}`}
        title="Open this line on the analysis board"
        className="group block font-mono text-sm leading-relaxed text-kca-white transition-colors hover:text-kca-cyan"
      >
        <span className="break-words">
          {moves.map((san, i) => (
            <span
              key={i}
              className={cn(
                outOfBookAtPly !== undefined && i >= outOfBookAtPly && "text-kca-gray-500",
              )}
            >
              {i % 2 === 0 ? <span className="text-kca-gray-600">{i / 2 + 1}.</span> : null}{" "}
              {san}
            </span>
          ))}
          <Play className="ml-1.5 inline h-3 w-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-100" />
        </span>
      </Link>
      {bookEndsAtMove !== null && (
        <p className="text-xs text-kca-gray-500">
          In their book through move {bookEndsAtMove}; grey moves are Stockfish&apos;s continuation,
          not lines they have played.
        </p>
      )}
    </div>
  );
}

function Moves({ moves }: { moves: string[] }) {
  if (moves.length === 0) return <span className="text-kca-gray-500">(starting position)</span>;
  return (
    <Link
      href={`/dashboard/analysis?pgn=${encodeURIComponent(toPgn(moves))}`}
      title="Open this line on the analysis board"
      className="group inline-flex items-center gap-1.5 font-mono text-sm text-kca-white hover:text-kca-cyan transition-colors"
    >
      <span className="underline decoration-dotted decoration-kca-gray-600 underline-offset-4 group-hover:decoration-kca-cyan">
        {moves.join(" ")}
      </span>
      <Play className="h-3 w-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-100" />
    </Link>
  );
}

function Section({
  title,
  icon: Icon,
  children,
}: {
  title: string;
  icon: typeof Target;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-8">
      <h2 className="mb-3 flex items-center gap-2 text-lg font-display font-bold text-kca-white">
        <Icon className="h-4 w-4 text-kca-cyan" /> {title}
      </h2>
      {children}
    </section>
  );
}

export default function DossierPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [regenError, setRegenError] = useState<string | null>(null);
  /** Held only for the duration of the POST — see `regenerate` below. */
  const [isSubmitting, setIsSubmitting] = useState(false);
  /** Two-step delete: the first click arms it, the second confirms. */
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollStartedAtRef = useRef(0);

  const load = useCallback(async (): Promise<Profile | null> => {
    try {
      const res = await fetch(`/api/second/profiles/${id}`);
      const data = await res.json();
      if (!data.success) {
        setError(data.message ?? "Could not load this dossier.");
        return null;
      }
      setProfile(data.profile);
      return data.profile as Profile;
    } catch {
      setError("Could not load this dossier.");
      return null;
    }
  }, [id]);

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  // Same shape as the dossier list page: poll while a run is in flight, and give
  // up after the timeout so a stuck job cannot poll forever.
  const startPolling = useCallback(() => {
    if (pollTimerRef.current) return;
    pollStartedAtRef.current = Date.now();
    pollTimerRef.current = setInterval(async () => {
      const latest = await load();
      const running = latest?.status === "pending" || latest?.status === "processing";
      if (!running || Date.now() - pollStartedAtRef.current > POLL_TIMEOUT_MS) {
        stopPolling();
      }
    }, POLL_INTERVAL_MS);
  }, [load, stopPolling]);

  useEffect(() => {
    async function initialLoad() {
      const latest = await load();
      setLoading(false);
      if (latest?.status === "pending" || latest?.status === "processing") startPolling();
    }

    void initialLoad();
    return stopPolling;
  }, [load, startPolling, stopPolling]);

  const isBusy = profile?.status === "pending" || profile?.status === "processing";

  const regenerate = useCallback(async () => {
    setRegenError(null);
    // `isBusy` is derived from the fetched status, which cannot update until
    // this request comes back — and the request is slow. That left the button
    // live for the whole round trip, so an impatient click became six jobs.
    // The server rejects the duplicates now, but not queuing them is better.
    setIsSubmitting(true);
    try {
      const res = await fetch(`/api/second/profiles/${id}/regenerate`, { method: "POST" });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setRegenError(data.message ?? "Could not start the regeneration.");
        return;
      }
      await load();
      startPolling();
    } catch {
      setRegenError("Could not start the regeneration.");
    } finally {
      setIsSubmitting(false);
    }
  }, [id, load, startPolling]);

  const remove = useCallback(async () => {
    setRegenError(null);
    setIsDeleting(true);
    try {
      const res = await fetch(`/api/second/profiles/${id}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setRegenError(data.message ?? "Could not delete this dossier.");
        setConfirmDelete(false);
        return;
      }
      // Stop the poller before navigating, or it keeps hitting a route that
      // now 404s and paints an error over the list page.
      stopPolling();
      router.replace("/dashboard/second");
      router.refresh();
    } catch {
      setRegenError("Could not delete this dossier.");
      setConfirmDelete(false);
    } finally {
      setIsDeleting(false);
    }
  }, [id, router, stopPolling]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-kca-cyan" />
      </div>
    );
  }

  if (error || !profile) {
    return (
      <div className="mx-auto w-full max-w-3xl">
        <Link href="/dashboard/second" className="mb-4 inline-flex items-center gap-1.5 text-sm text-kca-gray-400 hover:text-kca-white">
          <ArrowLeft className="h-4 w-4" /> Back to dossiers
        </Link>
        <div className="card border border-kca-danger/30 bg-kca-danger/10 p-6 text-kca-danger">
          {error ?? "Not found."}
        </div>
      </div>
    );
  }

  const a = profile.artifact;
  const mergedAccounts = a?.accounts ?? [];
  const isMulti = mergedAccounts.length > 1;
  const ratings =
    a?.ratingSummary
      ?.filter((r) => r.rating)
      // Prefix the handle only when it would otherwise be ambiguous — older
      // dossiers have no handle on these entries at all.
      .map((r) => (isMulti && r.handle ? `${r.handle} ${r.format} ${r.rating}` : `${r.format} ${r.rating}`))
      .join(" · ") || null;
  const headerTitle = mergedAccounts.length
    ? mergedAccounts.map((acc) => acc.handle).join(" / ")
    : profile.handle;
  const sites = mergedAccounts.length
    ? [...new Set(mergedAccounts.map((acc) => (acc.source === "LICHESS" ? "Lichess" : "Chess.com")))].join(
        " + ",
      )
    : profile.source === "LICHESS"
      ? "Lichess"
      : "Chess.com";

  return (
    <div className="mx-auto w-full max-w-3xl">
      <Link href="/dashboard/second" className="mb-4 inline-flex items-center gap-1.5 text-sm text-kca-gray-400 hover:text-kca-white">
        <ArrowLeft className="h-4 w-4" /> Back to dossiers
      </Link>

      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-display font-bold text-kca-white">{headerTitle}</h1>
          <p className="mt-1 text-sm text-kca-gray-400">
            {sites}
            {ratings && ` · ${ratings}`} · you play {profile.colorToPlay} · {profile.gamesAnalyzed} games
            profiled
            {profile.fideId && ` · FIDE ${profile.fideId}`}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={regenerate}
            disabled={isBusy || isSubmitting}
            className="btn-secondary py-2 px-4 disabled:opacity-50"
            title="Re-run the analysis against this opponent with the current server setup"
          >
            <RefreshCw className={cn("h-4 w-4", isBusy && "animate-spin")} />
            {isBusy ? "Regenerating…" : "Regenerate"}
          </button>
          {profile.repertoire?.hasPdf && (
            <a href={`/api/second/profiles/${profile.id}/download`} className="btn-secondary py-2 px-4">
              <Download className="h-4 w-4" /> PDF
            </a>
          )}
          {/* Two clicks, not a window.confirm: the dialog is easy to dismiss by
              reflex, and this keeps the warning in the page where it is read. */}
          <button
            type="button"
            onClick={() => (confirmDelete ? void remove() : setConfirmDelete(true))}
            onBlur={() => setConfirmDelete(false)}
            disabled={isBusy || isDeleting}
            className={cn(
              "py-2 px-4 disabled:opacity-50",
              confirmDelete
                ? "btn-secondary border-kca-danger/60 text-kca-danger"
                : "btn-secondary text-kca-gray-400 hover:text-kca-danger",
            )}
            title={
              isBusy
                ? "Wait for the current run to finish before deleting"
                : "Permanently delete this dossier"
            }
          >
            {isDeleting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Trash2 className="h-4 w-4" />
            )}
            {isDeleting ? "Deleting…" : confirmDelete ? "Confirm delete" : "Delete"}
          </button>
        </div>
      </div>

      {confirmDelete && !isDeleting && (
        <div className="mb-4 rounded-xl border border-kca-danger/30 bg-kca-danger/10 px-4 py-3 text-sm text-kca-danger">
          This permanently removes the dossier, its repertoire and its PDF. It cannot be undone —
          you would have to profile {profile.handle} again from scratch. Click Confirm delete to
          proceed, or click anywhere else to cancel.
        </div>
      )}

      {regenError && (
        <div className="mb-4 rounded-xl border border-kca-danger/30 bg-kca-danger/10 px-4 py-3 text-sm text-kca-danger">
          {regenError}
        </div>
      )}

      {profile.status !== "complete" && (
        <div className="card mb-6 border border-kca-border bg-kca-surface p-5 text-kca-gray-300">
          {profile.status === "failed"
            ? profile.summary ?? "Profiling failed."
            : "This dossier is still being built — check back shortly."}
        </div>
      )}

      {profile.summary && profile.status === "complete" && (
        <Section title="Briefing" icon={BookOpen}>
          <div className="card space-y-3 border border-kca-border bg-kca-surface p-5 text-sm leading-relaxed text-kca-gray-200">
            {profile.summary.split("\n").filter(Boolean).map((p, i) => (
              <p key={i} className="whitespace-pre-wrap">{p}</p>
            ))}
          </div>
        </Section>
      )}

      {profile.repertoire && profile.repertoire.lines.length > 0 && (
        <Section title="Recommended repertoire" icon={Target}>
          <p className="mb-3 -mt-1 text-xs text-kca-gray-500">
            Click any move-order to open it on the analysis board and play through it with the engine.
          </p>
          <ol className="space-y-3">
            {profile.repertoire.lines.map((l, i) => (
              <li key={i} className="card border border-kca-border bg-kca-surface p-4">
                <div className="mb-1.5 flex items-start gap-2">
                  <span className={cn("mt-0.5 shrink-0 rounded border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider", TAG_STYLES[l.tag] ?? TAG_STYLES.mainline)}>
                    {l.tag}
                  </span>
                  <LineMoves moves={l.moves} outOfBookAtPly={l.outOfBookAtPly} />
                </div>
                <p className="text-sm text-kca-gray-400">{l.rationale}</p>
              </li>
            ))}
          </ol>
        </Section>
      )}

      {/* Provenance, not decoration. Merging accounts means one shared recency
          reference, which correctly discounts an account the player abandoned —
          but that decision has to be VISIBLE, or a dossier quietly built almost
          entirely from one account looks the same as one built from five. */}
      {a && mergedAccounts.length > 0 && (
        <Section title="Sources" icon={Layers}>
          <div className="space-y-2">
            {mergedAccounts.map((acc, i) => {
              const stale = acc.gamesUsed > 0 && acc.meanWeight < 0.25;
              return (
                <div key={i} className="card border border-kca-border bg-kca-surface p-4">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="font-mono text-sm text-kca-white">{acc.handle}</span>
                    <span className="text-xs text-kca-gray-400">
                      {acc.source === "LICHESS" ? "Lichess" : "Chess.com"}
                    </span>
                  </div>
                  {acc.status !== "ok" ? (
                    <p className="mt-1.5 text-sm text-kca-danger">
                      {acc.status === "not-found"
                        ? "Account not found — check the username and that the profile is public. No games from it are in this dossier."
                        : acc.status === "rate-limited"
                          ? "The site rate-limited this account, so its games are missing. Regenerate to retry."
                          : "This account could not be reached, so its games are missing. Regenerate to retry."}
                    </p>
                  ) : (
                    <p className="mt-1.5 text-sm text-kca-gray-400">
                      {acc.gamesUsed} games used
                      {acc.gamesFetched !== acc.gamesUsed && ` of ${acc.gamesFetched} fetched`}
                      {acc.oldestPlayedAt && acc.newestPlayedAt && (
                        <>
                          {" "}
                          · {acc.oldestPlayedAt.slice(0, 10)} → {acc.newestPlayedAt.slice(0, 10)}
                        </>
                      )}{" "}
                      · recency{" "}
                      <span className={cn(stale ? "text-kca-warning" : "text-kca-gray-100")}>
                        {acc.meanWeight.toFixed(2)}
                      </span>
                    </p>
                  )}
                  {stale && (
                    <p className="mt-1 text-xs text-kca-warning">
                      Most of this account&rsquo;s games are over a year old, so they are heavily
                      discounted against the newer accounts here.
                    </p>
                  )}
                </div>
              );
            })}
          </div>

          {a.ingest && (
            <p className="mt-3 text-xs text-kca-gray-500">
              {a.ingest.totalFetched} games fetched
              {a.ingest.duplicatesDropped > 0 && `, ${a.ingest.duplicatesDropped} duplicates dropped`}
              {a.ingest.selfPlayDropped > 0 &&
                `, ${a.ingest.selfPlayDropped} dropped where two of these accounts played each other`}
              {a.ingest.budgetTrimmed > 0 &&
                `, ${a.ingest.budgetTrimmed} older games trimmed to the limit`}
              {a.ingest.clocksDiscardedMisaligned > 0 &&
                `, ${a.ingest.clocksDiscardedMisaligned} games had unusable clock data`}
              .
              {a.ingest.budgetReduced &&
                " This dossier ran without the job queue, so it used a reduced sample — start the worker and regenerate for the full one."}
            </p>
          )}

          {a.clockBasis && (
            <p className="mt-1.5 text-xs text-kca-gray-500">
              {a.clockBasis.initialSec
                ? `Think times are increment-corrected and measured only on their ~${a.clockBasis.initialSec}s games (${a.clockBasis.gamesUsed} games; ${a.clockBasis.gamesExcluded} excluded as a different time control), so a bullet game and a rapid game are never averaged together.`
                : "These games carried no usable clock data, so no think-time figures are given."}
            </p>
          )}
        </Section>
      )}

      {a?.tactical && a.tactical.motifs.length > 0 && (
        <Section title="Tactical profile" icon={Swords}>
          <div className="space-y-2">
            {a.tactical.motifs.map((m) => {
              const thin = m.opportunities < a.tactical!.minOpportunities;
              return (
                <div key={m.motif} className="card border border-kca-border bg-kca-surface p-4">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="text-sm font-semibold text-kca-white">
                      {MOTIF_LABEL[m.motif] ?? m.motif}
                    </span>
                    {thin ? (
                      // Printing "50%" from two events is how a dossier becomes
                      // superstition. Say there is not enough evidence instead.
                      <span className="text-xs text-kca-gray-400">
                        Not enough evidence ({m.opportunities}{" "}
                        {m.opportunities === 1 ? "chance" : "chances"} seen)
                      </span>
                    ) : (
                      <span className="text-sm">
                        <span className="text-kca-danger">
                          missed {m.missed} of {m.opportunities}
                        </span>{" "}
                        <span className="text-kca-gray-400">
                          ({(m.missRate * 100).toFixed(0)}%)
                        </span>
                      </span>
                    )}
                  </div>
                  {!thin && (
                    <p className="mt-1.5 text-xs text-kca-gray-400">
                      Executed it {m.found}{" "}
                      {m.found === 1 ? "time" : "times"} · true rate is somewhere between{" "}
                      {(m.missRateLow * 100).toFixed(0)}% and {(m.missRateHigh * 100).toFixed(0)}% ·
                      this motif is detected with {(m.detectorPrecision * 100).toFixed(0)}% precision
                    </p>
                  )}
                </div>
              );
            })}
          </div>
          <p className="mt-3 text-xs text-kca-gray-500">
            Measured over {a.tactical.gamesScanned} whole games ({a.tactical.positionsScanned} of
            their own moves engine-graded). A &ldquo;chance&rdquo; is a position where Stockfish&rsquo;s
            best move was that tactic. Detector precision is measured against{" "}
            {"Lichess'"}s own labelled puzzles, so a 90% figure means roughly one in ten flagged
            positions is not really that motif — read the ranges, not the single numbers.
          </p>
        </Section>
      )}

      {a?.behaviour && (
        <Section title="Behavioural patterns" icon={Activity}>
          {[
            ...(a.behaviour.clockDataAvailable
              ? [
                  { heading: "As their clock runs down", buckets: a.behaviour.timePressure },
                  { heading: "Think time", buckets: a.behaviour.longThink },
                ]
              : []),
            { heading: "After their previous game", buckets: a.behaviour.tilt },
            { heading: "By position type", buckets: a.behaviour.structures },
          ]
            .filter((group) => group.buckets.some((x) => x.n >= a.behaviour!.minSamples))
            .map((group) => (
              <div key={group.heading} className="mb-4">
                <div className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-kca-gray-400">
                  {group.heading}
                </div>
                <div className="space-y-1.5">
                  {group.buckets
                    .filter((bucket) => bucket.n >= a.behaviour!.minSamples)
                    .map((bucket) => (
                      <div
                        key={bucket.label}
                        className="card flex flex-wrap items-baseline justify-between gap-2 border border-kca-border bg-kca-surface px-4 py-2.5"
                      >
                        <span className="text-sm text-kca-gray-100">{bucket.label}</span>
                        <span className="text-sm text-kca-gray-400">
                          <span className="text-kca-white">{bucket.accuracy.toFixed(1)}%</span>{" "}
                          accuracy ({bucket.accuracyLow.toFixed(1)}–{bucket.accuracyHigh.toFixed(1)})
                          · {(bucket.blunderRate * 100).toFixed(0)}% blunders · {bucket.n} moves
                        </span>
                      </div>
                    ))}
                </div>
              </div>
            ))}

          {a.behaviour.terminations.length > 0 && (
            <div className="mb-4">
              <div className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-kca-gray-400">
                How their {a.behaviour.lossesAnalyzed} losses ended
              </div>
              <div className="space-y-1.5">
                {a.behaviour.terminations.map((t) => (
                  <div
                    key={t.termination}
                    className="card flex items-baseline justify-between gap-2 border border-kca-border bg-kca-surface px-4 py-2.5"
                  >
                    <span className="text-sm text-kca-gray-100">{t.label}</span>
                    <span className="text-sm text-kca-gray-400">
                      <span className="text-kca-white">{(t.share * 100).toFixed(0)}%</span> ({t.count})
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* The framing is not optional. These are correlations over their own
              games; without saying so, an accuracy dip under time pressure reads
              as a claim about what the opponent feels. */}
          <p className="text-xs text-kca-gray-500">
            Measured over {a.behaviour.movesGraded} of their own moves across{" "}
            {a.behaviour.gamesScanned} games. These are patterns in how they have played, not
            claims about what they think or feel — and a gap smaller than the ranges shown is not
            yet a real difference. Buckets with fewer than {a.behaviour.minSamples} moves are
            hidden rather than shown as a percentage.
            {!a.behaviour.clockDataAvailable &&
              " Clock-based sections are hidden: too few of these games carried usable clock data."}
          </p>
        </Section>
      )}

      {a && a.weaknesses.length > 0 && (
        <Section title="Their weakest positions" icon={Target}>
          <div className="space-y-2">
            {a.weaknesses.map((w, i) => (
              <div key={i} className="card border border-kca-border bg-kca-surface p-4">
                <Moves moves={w.line} />
                <p className="mt-1.5 text-sm text-kca-gray-400">
                  They usually play <span className="font-mono text-kca-white">{w.theirMove}</span> —{" "}
                  <span className="text-kca-danger">{w.accuracy}% accuracy</span>
                  {w.avgClockSpent !== null && `, ~${w.avgClockSpent}s spent`} · seen {w.weightedFrequency}×
                </p>
              </div>
            ))}
          </div>
        </Section>
      )}

      {a && a.novelties.length > 0 && (
        <Section title="Mined novelties" icon={Sparkles}>
          <div className="space-y-2">
            {a.novelties.map((n, i) => (
              <div key={i} className="card border border-kca-border bg-kca-surface p-4">
                <div className="flex items-baseline gap-2">
                  <span className="font-mono text-base font-semibold text-kca-cyan">{n.move}</span>
                  {/* Include the novelty itself so the board opens on the move, not before it. */}
                  <Moves moves={[...n.line, n.move]} />
                </div>
                <p className="mt-1.5 text-sm text-kca-gray-400">
                  Engine {n.evalCp ?? 0}cp · played in{" "}
                  {n.explorerShare === null ? "unknown" : `${(n.explorerShare * 100).toFixed(1)}%`} of human
                  games
                </p>
              </div>
            ))}
          </div>
        </Section>
      )}

      {a && (a.transpositions.length > 0 || !a.graphUsed) && (
        <Section title="Transposition bypasses" icon={Shuffle}>
          {a.transpositions.length === 0 ? (
            <div className="card border border-kca-border bg-kca-surface p-4 text-sm text-kca-gray-400">
              {graphSkipMessage(a.graphSkipReason)}
            </div>
          ) : (
            <div className="space-y-2">
              {a.transpositions.map((t, i) => (
                <div key={i} className="card border border-kca-border bg-kca-surface p-4">
                  {/* Older dossiers stored only the short bypass. */}
                  <LineMoves moves={t.extended ?? t.bypass} outOfBookAtPly={t.outOfBookAtPly} />
                  <p className="mt-1.5 text-sm text-kca-gray-400">{t.note}</p>
                </div>
              ))}
            </div>
          )}
        </Section>
      )}

      {a && a.trieSummary.length > 0 && (
        <Section title="Their repertoire" icon={BookOpen}>
          <div className="card divide-y divide-kca-border border border-kca-border bg-kca-surface">
            {a.trieSummary.map((s, i) => (
              <div key={i} className="flex items-center justify-between gap-4 p-3">
                <Moves moves={s.line} />
                <span className="shrink-0 text-xs text-kca-gray-400">
                  {s.scorePct}% score · weight {s.weightedCount}
                </span>
              </div>
            ))}
          </div>
        </Section>
      )}
    </div>
  );
}
