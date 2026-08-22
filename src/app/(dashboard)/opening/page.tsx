"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

type Candidate = { name: string; eco: string; moves?: string[] };
type RepertoireRow = { id: string; name: string; eco: string | null; colorToPlay: string; status: string };

export default function OpeningTrainerPage() {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [showList, setShowList] = useState(false);
  const [color, setColor] = useState<"white" | "black">("white");
  const [recent, setRecent] = useState<RepertoireRow[]>([]);
  const [saved, setSaved] = useState<RepertoireRow[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadLists = useCallback(async () => {
    try {
      const res = await fetch("/api/opening");
      const data = await res.json();
      if (data.success) {
        setRecent(data.repertoires ?? []);
        setSaved((data.saved ?? []).filter(Boolean));
      }
    } catch {
      /* non-fatal */
    }
  }, []);

  useEffect(() => {
    loadLists();
  }, [loadLists]);

  // Debounced autocomplete.
  useEffect(() => {
    if (debounce.current) clearTimeout(debounce.current);
    if (query.trim().length < 2) {
      setCandidates([]);
      return;
    }
    debounce.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/opening/resolve?q=${encodeURIComponent(query.trim())}`);
        const data = await res.json();
        if (data.success) {
          setCandidates(data.candidates ?? []);
          setShowList(true);
        }
      } catch {
        /* ignore */
      }
    }, 200);
    return () => {
      if (debounce.current) clearTimeout(debounce.current);
    };
  }, [query]);

  async function build(openingName?: string) {
    const name = (openingName ?? query).trim();
    if (name.length < 2) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/opening", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ opening: name, colorToPlay: color }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setError(data.message ?? "Could not build that repertoire.");
        setSubmitting(false);
        return;
      }
      router.push(`/dashboard/opening/${data.repertoireId}`);
    } catch {
      setError("Network error — please try again.");
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto max-w-4xl px-4 py-8">
      <h1 className="section-heading">Opening Trainer</h1>
      <p className="section-subheading mb-6">
        Type an opening, gambit, or trap. Digital Second builds a repertoire of its major variations —
        each to ~15 moves — with the engine&apos;s best line and a coach that explains the ideas.
      </p>

      <div className="card mb-8">
        <div className="relative">
          <label className="mb-1 block text-sm text-kca-gray-400">Opening name</label>
          <input
            className="input-field w-full"
            placeholder="e.g. Caro-Kann Defence, Evans Gambit, Fried Liver Attack"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setError(null);
            }}
            onFocus={() => candidates.length && setShowList(true)}
            onKeyDown={(e) => e.key === "Enter" && build()}
          />
          {showList && candidates.length > 0 && (
            <ul className="absolute left-0 right-0 z-50 mt-1 max-h-72 overflow-auto rounded-lg border border-kca-border-bright bg-kca-surface-2 shadow-2xl">
              {candidates.map((c) => (
                <li key={`${c.eco}-${c.name}`}>
                  <button
                    type="button"
                    className="flex w-full items-center justify-between px-3 py-2 text-left hover:bg-kca-surface-3"
                    onClick={() => {
                      setQuery(c.name);
                      setShowList(false);
                    }}
                  >
                    <span className="text-sm text-kca-white">{c.name}</span>
                    <span className="ml-3 font-mono text-xs text-kca-gray-400">{c.eco}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="mt-4 flex flex-wrap items-end gap-3">
          <div>
            <label className="mb-1 block text-sm text-kca-gray-400">You play</label>
            <select
              className="input-field"
              value={color}
              onChange={(e) => setColor(e.target.value as "white" | "black")}
            >
              <option value="white">White</option>
              <option value="black">Black</option>
            </select>
          </div>
          <button type="button" className="btn-primary" disabled={submitting} onClick={() => build()}>
            {submitting ? "Building…" : "Build repertoire"}
          </button>
        </div>
        {error && <p className="mt-3 text-sm text-kca-danger">{error}</p>}
      </div>

      {saved.length > 0 && (
        <section className="mb-8">
          <h2 className="mb-3 text-lg font-semibold text-kca-white">Your saved openings</h2>
          <RepertoireGrid rows={saved} />
        </section>
      )}

      <section>
        <h2 className="mb-3 text-lg font-semibold text-kca-white">Recently generated</h2>
        {recent.length === 0 ? (
          <p className="text-sm text-kca-gray-400">Nothing yet — build your first repertoire above.</p>
        ) : (
          <RepertoireGrid rows={recent} />
        )}
      </section>
    </div>
  );
}

function RepertoireGrid({ rows }: { rows: RepertoireRow[] }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {rows.map((r) => (
        <Link
          key={r.id}
          href={`/dashboard/opening/${r.id}`}
          className="card flex items-center justify-between transition hover:border-kca-cyan"
        >
          <div>
            <div className="font-medium text-kca-white">{r.name}</div>
            <div className="text-xs text-kca-gray-400">
              {r.eco ? `${r.eco} · ` : ""}
              You play {r.colorToPlay}
              {r.status !== "complete" ? ` · ${r.status}…` : ""}
            </div>
          </div>
          <span className="text-kca-cyan">→</span>
        </Link>
      ))}
    </div>
  );
}
