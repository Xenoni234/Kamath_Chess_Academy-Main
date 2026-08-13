"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Download, Loader2, Target, Sparkles, Shuffle, BookOpen } from "lucide-react";
import { cn } from "@/lib/utils";

type Weakness = {
  line: string[];
  theirMove: string;
  accuracy: number;
  avgClockSpent: number | null;
  weightedFrequency: number;
  weaknessScore: number;
};
type Novelty = { line: string[]; move: string; evalCp: number | null; explorerShare: number | null };
type Transposition = { bypass: string[]; mainLine: string[]; note: string };
type RepLine = { moves: string[]; rationale: string; tag: string };

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

function Moves({ moves }: { moves: string[] }) {
  if (moves.length === 0) return <span className="text-kca-gray-500">(starting position)</span>;
  return <span className="font-mono text-sm text-kca-white">{moves.join(" ")}</span>;
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

  useEffect(() => {
    fetch(`/api/second/profiles/${id}`)
      .then((r) => r.json())
      .then((data) => {
        if (data.success) setProfile(data.profile);
        else setError(data.message ?? "Could not load this dossier.");
      })
      .catch(() => setError("Could not load this dossier."))
      .finally(() => setLoading(false));
  }, [id]);

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
        {profile.repertoire?.hasPdf && (
          <a href={`/api/second/profiles/${profile.id}/download`} className="btn-secondary shrink-0 py-2 px-4">
            <Download className="h-4 w-4" /> PDF
          </a>
        )}
      </div>

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
          <ol className="space-y-3">
            {profile.repertoire.lines.map((l, i) => (
              <li key={i} className="card border border-kca-border bg-kca-surface p-4">
                <div className="mb-1.5 flex items-center gap-2">
                  <span className={cn("rounded border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider", TAG_STYLES[l.tag] ?? TAG_STYLES.mainline)}>
                    {l.tag}
                  </span>
                  <Moves moves={l.moves} />
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
                  <Moves moves={n.line} />
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
              Transposition analysis is unavailable — the graph database is not configured.
            </div>
          ) : (
            <div className="space-y-2">
              {a.transpositions.map((t, i) => (
                <div key={i} className="card border border-kca-border bg-kca-surface p-4">
                  <Moves moves={t.bypass} />
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
