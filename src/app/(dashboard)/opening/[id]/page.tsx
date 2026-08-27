"use client";

import { use, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Chess } from "chess.js";
import ChessBoard from "@/components/chess/ChessBoard";

type Line = {
  moves: string[];
  rationale: string;
  tag: string;
  outOfBookAtPly?: number;
  evalCp?: number | null;
};
type Variation = { eco: string; name: string; line: string[]; popularity: number | null; tag: string };
type Artifact = {
  name: string;
  eco: string | null;
  family: string;
  colorToPlay: "white" | "black";
  rootMoves: string[];
  variations: Variation[];
  bestLineIndex: number | null;
  explorerCoverage: { positionsQueried: number; positionsWithData: number; hasToken: boolean };
};
type Repertoire = {
  id: string;
  name: string;
  eco: string | null;
  colorToPlay: "white" | "black";
  status: string;
  artifact: Artifact | null;
  lines: Line[] | null;
  guide: string | null;
  hasPdf: boolean;
  saved: boolean;
};

const POLL_MS = 4000;

/** Replay a SAN line into per-ply FENs (index 0 = start) and UCIs. */
function replay(moves: string[]): { fens: string[]; ucis: string[] } {
  const chess = new Chess();
  const fens = [chess.fen()];
  const ucis: string[] = [];
  for (const san of moves) {
    try {
      const mv = chess.move(san);
      if (!mv) break;
      ucis.push(`${mv.from}${mv.to}${mv.promotion ?? ""}`);
      fens.push(chess.fen());
    } catch {
      break;
    }
  }
  return { fens, ucis };
}

export default function OpeningDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [rep, setRep] = useState<Repertoire | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState(0);
  const [ply, setPly] = useState(0);
  const [explanation, setExplanation] = useState("");
  const [explaining, setExplaining] = useState(false);
  const [busy, setBusy] = useState(false);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/opening/${id}`);
      const data = await res.json();
      if (!res.ok || !data.success) {
        setError(data.message ?? "Not found");
        return null;
      }
      setRep(data.repertoire);
      return data.repertoire as Repertoire;
    } catch {
      setError("Network error");
      return null;
    }
  }, [id]);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      const r = await load();
      if (cancelled) return;
      if (r && (r.status === "pending" || r.status === "processing")) {
        pollRef.current = setTimeout(tick, POLL_MS);
      }
    };
    tick();
    return () => {
      cancelled = true;
      if (pollRef.current) clearTimeout(pollRef.current);
    };
  }, [load]);

  const lines = rep?.lines ?? [];
  const variations = rep?.artifact?.variations ?? [];
  const currentLine = lines[selected];
  const { fens, ucis } = useMemo(() => replay(currentLine?.moves ?? []), [currentLine]);
  const maxPly = fens.length - 1;
  const safePly = Math.min(ply, maxPly);
  const orientation = rep?.colorToPlay ?? "white";

  /** Switch variation, rewinding the board and dropping the old explanation.
   *  Done here rather than in an effect on `selected` — resetting state from an
   *  effect triggers a second render pass for every click. */
  function selectVariation(index: number) {
    setSelected(index);
    setPly(0);
    setExplanation("");
  }

  async function explainCurrent() {
    if (safePly < 1 || !currentLine) return;
    setExplaining(true);
    setExplanation("");
    try {
      const res = await fetch("/api/analysis/explain", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Position before the move, plus the move. The server searches it and
        // derives the evaluation, the alternatives and the tactics itself.
        // (This used to send the played move as its own "best move", the
        // evaluation from the END of the whole variation, and an empty
        // alternatives list — so every specific claim was invented.)
        body: JSON.stringify({
          fen: fens[safePly - 1],
          playedUci: ucis[safePly - 1],
        }),
      });
      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}));
        setExplanation(data.message ?? "Explanations are not available right now.");
        setExplaining(false);
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let text = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
        setExplanation(text);
      }
    } catch {
      setExplanation("Could not stream an explanation.");
    } finally {
      setExplaining(false);
    }
  }

  async function toggleSave() {
    if (!rep) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/opening/${id}/save`, { method: rep.saved ? "DELETE" : "POST" });
      const data = await res.json();
      if (data.success) setRep({ ...rep, saved: data.saved });
    } finally {
      setBusy(false);
    }
  }

  async function regenerate() {
    setBusy(true);
    try {
      const res = await fetch(`/api/opening/${id}/regenerate`, { method: "POST" });
      if (res.ok) {
        await load();
        if (pollRef.current) clearTimeout(pollRef.current);
        const tick = async () => {
          const r = await load();
          if (r && (r.status === "pending" || r.status === "processing")) pollRef.current = setTimeout(tick, POLL_MS);
        };
        tick();
      }
    } finally {
      setBusy(false);
    }
  }

  if (error) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-10">
        <p className="text-kca-danger">{error}</p>
        <Link href="/dashboard/opening" className="btn-secondary mt-4 inline-block">
          ← Back to Opening Trainer
        </Link>
      </div>
    );
  }

  if (!rep) {
    return <div className="mx-auto max-w-3xl px-4 py-10 text-kca-gray-400">Loading…</div>;
  }

  if (rep.status === "pending" || rep.status === "processing") {
    return (
      <div className="mx-auto max-w-3xl px-4 py-10 text-center">
        <div className="card">
          <h1 className="section-heading">{rep.name}</h1>
          <p className="mt-2 text-kca-gray-100">
            Building your {rep.colorToPlay} repertoire — analysing variations with the engine and writing the
            coach&apos;s guide. This runs once and is cached, so it&apos;s instant next time.
          </p>
          <div className="mt-4 animate-pulse text-kca-cyan">Working… ({rep.status})</div>
        </div>
      </div>
    );
  }

  if (rep.status === "failed") {
    return (
      <div className="mx-auto max-w-3xl px-4 py-10">
        <div className="card">
          <h1 className="section-heading">{rep.name}</h1>
          <p className="mt-2 text-kca-danger">Generation failed. Try regenerating.</p>
          <button type="button" className="btn-primary mt-4" disabled={busy} onClick={regenerate}>
            Regenerate
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link href="/dashboard/opening" className="text-sm text-kca-gray-400 hover:text-kca-cyan">
            ← Opening Trainer
          </Link>
          <h1 className="section-heading">{rep.name}</h1>
          <p className="text-sm text-kca-gray-400">
            {rep.eco ? `${rep.eco} · ` : ""}You play {rep.colorToPlay} · {variations.length} variations
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn-secondary" disabled={busy} onClick={toggleSave}>
            {rep.saved ? "★ Saved" : "☆ Save"}
          </button>
          {rep.hasPdf && (
            <a className="btn-secondary" href={`/api/opening/${id}/download`}>
              Download PDF
            </a>
          )}
          <button type="button" className="btn-secondary" disabled={busy} onClick={regenerate}>
            Regenerate
          </button>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        {/* Left: variation list + guide */}
        <div className="order-2 lg:order-1">
          <div className="card mb-6">
            <h2 className="mb-3 text-lg font-semibold text-kca-white">Variations</h2>
            <ul className="space-y-1">
              {variations.map((v, i) => {
                const isBest = rep.artifact?.bestLineIndex === i;
                return (
                  <li key={`${v.eco}-${v.name}-${i}`}>
                    <button
                      type="button"
                      onClick={() => selectVariation(i)}
                      className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm transition ${
                        selected === i ? "bg-kca-surface-3 text-kca-white" : "hover:bg-kca-surface-2 text-kca-gray-100"
                      }`}
                    >
                      <span className="flex items-center gap-2">
                        {v.name}
                        {isBest && <span className="rounded bg-kca-cyan px-1.5 py-0.5 text-[10px] font-semibold text-black">BEST</span>}
                        {v.tag === "gambit" && <span className="rounded bg-kca-warning/20 px-1.5 py-0.5 text-[10px] text-kca-warning">gambit</span>}
                        {v.tag === "trap" && <span className="rounded bg-kca-danger/20 px-1.5 py-0.5 text-[10px] text-kca-danger">trap</span>}
                      </span>
                      <span className="ml-2 font-mono text-xs text-kca-gray-400">{v.eco}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>

          <div className="card">
            <h2 className="mb-3 text-lg font-semibold text-kca-white">Coach&apos;s guide</h2>
            <div className="space-y-3 text-sm leading-relaxed text-kca-gray-100">
              {(rep.guide ?? "").split(/\n\n+/).map((p, i) => (
                <p key={i}>{p}</p>
              ))}
            </div>
          </div>
        </div>

        {/* Right: board + move stepper + explanation */}
        <div className="order-1 lg:order-2">
          <div className="card">
            <ChessBoard fen={fens[safePly]} orientation={orientation} onMove={() => {}} disabled lastMove={safePly > 0 ? ucis[safePly - 1] : undefined} />
            <div className="mt-3 flex items-center gap-1.5">
              <button type="button" aria-label="Start" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-kca-border bg-kca-surface-2 text-sm text-kca-cyan transition hover:border-kca-cyan disabled:cursor-not-allowed disabled:opacity-40" disabled={safePly === 0} onClick={() => setPly(0)}>
                ⏮
              </button>
              <button type="button" aria-label="Back" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-kca-border bg-kca-surface-2 text-sm text-kca-cyan transition hover:border-kca-cyan disabled:cursor-not-allowed disabled:opacity-40" disabled={safePly === 0} onClick={() => setPly((p) => Math.max(0, p - 1))}>
                ◀
              </button>
              <span className="flex-1 whitespace-nowrap text-center text-xs text-kca-gray-400">
                {safePly === 0 ? "start" : `move ${Math.ceil(safePly / 2)}${safePly % 2 ? " (W)" : " (B)"}`}
              </span>
              <button type="button" aria-label="Forward" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-kca-border bg-kca-surface-2 text-sm text-kca-cyan transition hover:border-kca-cyan disabled:cursor-not-allowed disabled:opacity-40" disabled={safePly >= maxPly} onClick={() => setPly((p) => Math.min(maxPly, p + 1))}>
                ▶
              </button>
              <button type="button" aria-label="End" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-kca-border bg-kca-surface-2 text-sm text-kca-cyan transition hover:border-kca-cyan disabled:cursor-not-allowed disabled:opacity-40" disabled={safePly >= maxPly} onClick={() => setPly(maxPly)}>
                ⏭
              </button>
            </div>

            <div className="mt-3 font-mono text-xs leading-relaxed text-kca-gray-100">
              {(currentLine?.moves ?? []).map((m, i) => (
                <span
                  key={i}
                  className={`cursor-pointer rounded px-1 ${i + 1 === safePly ? "bg-kca-cyan/30 text-kca-white" : ""} ${
                    currentLine?.outOfBookAtPly !== undefined && i >= currentLine.outOfBookAtPly ? "text-kca-gray-400" : ""
                  }`}
                  onClick={() => setPly(i + 1)}
                >
                  {i % 2 === 0 ? `${i / 2 + 1}.` : ""}
                  {m}{" "}
                </span>
              ))}
            </div>
            {currentLine?.outOfBookAtPly !== undefined && (
              <p className="mt-2 text-[11px] italic text-kca-gray-400">
                Popular human play to move {Math.ceil(currentLine.outOfBookAtPly / 2)}; the rest is the engine&apos;s
                continuation.
              </p>
            )}

            <button
              type="button"
              className="btn-primary mt-4 w-full"
              disabled={safePly < 1 || explaining}
              onClick={explainCurrent}
            >
              {explaining ? "Explaining…" : safePly < 1 ? "Step forward, then explain a move" : `Explain ${currentLine?.moves[safePly - 1] ?? ""}`}
            </button>
            {explanation && (
              <div className="mt-3 rounded-lg border border-kca-border bg-kca-surface-2 p-3 text-sm leading-relaxed text-kca-gray-100">
                {explanation}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
