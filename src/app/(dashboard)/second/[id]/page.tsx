"use client";

import { use, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  BookOpen,
  Download,
  Loader2,
  Play,
  RefreshCw,
  Shuffle,
  Sparkles,
  Target,
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

type Artifact = {
  handle: string;
  source: string;
  colorToPlay: string;
  gamesAnalyzed: number;
  ratingSummary: { format: string; rating: number | null }[];
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
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [regenError, setRegenError] = useState<string | null>(null);
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
    }
  }, [id, load, startPolling]);

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
  const ratings =
    a?.ratingSummary?.filter((r) => r.rating).map((r) => `${r.format} ${r.rating}`).join(" · ") || null;

  return (
    <div className="mx-auto w-full max-w-3xl">
      <Link href="/dashboard/second" className="mb-4 inline-flex items-center gap-1.5 text-sm text-kca-gray-400 hover:text-kca-white">
        <ArrowLeft className="h-4 w-4" /> Back to dossiers
      </Link>

      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-display font-bold text-kca-white">{profile.handle}</h1>
          <p className="mt-1 text-sm text-kca-gray-400">
            {profile.source === "LICHESS" ? "Lichess" : "Chess.com"}
            {ratings && ` · ${ratings}`} · you play {profile.colorToPlay} · {profile.gamesAnalyzed} games
            profiled
            {profile.fideId && ` · FIDE ${profile.fideId}`}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={regenerate}
            disabled={isBusy}
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
        </div>
      </div>

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
