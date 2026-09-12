"use client";

import { use, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Chess } from "chess.js";
import ChessBoard from "@/components/chess/ChessBoard";
import Markdown from "@/components/common/Markdown";

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

  /**
   * Arrow keys step through the line, same as the analysis board.
   *
   * This page had no keyboard handling at all, so the only way through a twenty-move
   * repertoire line was clicking the small ◀ ▶ buttons once per move — which is exactly
   * the sort of thing you do fifty times while studying an opening.
   *
   * Typing is left alone (the coach panel has inputs), and preventDefault stops the arrows
   * also scrolling the page while you step.
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (target?.isContentEditable) return;

      if (event.key === "ArrowLeft") setPly((current) => Math.max(0, Math.min(maxPly, current) - 1));
      else if (event.key === "ArrowRight") setPly((current) => Math.min(maxPly, current + 1));
      else if (event.key === "Home") setPly(0);
      else if (event.key === "End") setPly(maxPly);
      else return;

      event.preventDefault();
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [maxPly]);

  /** Switch variation, rewinding the board and dropping the old explanation.
   *  Done here rather than in an effect on `selected` — resetting state from an
   *  effect triggers a second render pass for every click. */
  function selectVariation(index: number) {
    setSelected(index);
    setPly(0);
    setExplanation("");
  }

  /**
   * Explain the move that LANDS on `atPly`.
   *
   * Takes the ply explicitly rather than reading `safePly`, because the button
   * below advances the board and explains in the same click — and `setPly` has
   * not been applied yet at that point.
   */
  async function explainCurrent(atPly: number = safePly) {
    if (atPly < 1 || !currentLine) return;
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
          fen: fens[atPly - 1],
          playedUci: ucis[atPly - 1],
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

  const stepBtn =
    "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-kca-border bg-kca-surface-2 text-sm text-kca-cyan transition hover:border-kca-cyan hover:bg-kca-surface-3 disabled:cursor-not-allowed disabled:opacity-40";

  // Moves grouped into numbered pairs so the list aligns as a real score sheet
  // instead of wrapping as one undifferentiated run of tokens.
  const moves = currentLine?.moves ?? [];
  const pairs: { no: number; white?: string; black?: string; wi: number; bi: number }[] = [];
  for (let i = 0; i < moves.length; i += 2) {
    pairs.push({ no: i / 2 + 1, white: moves[i], black: moves[i + 1], wi: i + 1, bi: i + 2 });
  }
  const bookEnd = currentLine?.outOfBookAtPly;

  return (
    <div className="mx-auto max-w-[1400px] px-4 py-8 lg:px-6">
      {/* Header */}
      <div className="mb-6">
        <Link
          href="/dashboard/opening"
          className="inline-flex items-center gap-1 text-sm text-kca-gray-400 transition hover:text-kca-cyan"
        >
          ← Opening Trainer
        </Link>
        <div className="mt-2 flex flex-wrap items-end justify-between gap-4">
          <div className="min-w-0">
            <h1 className="section-heading truncate">{rep.name}</h1>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {rep.eco && (
                <span className="rounded-md border border-kca-border bg-kca-surface-2 px-2 py-0.5 font-mono text-xs text-kca-cyan">
                  {rep.eco}
                </span>
              )}
              <span className="rounded-md border border-kca-border bg-kca-surface-2 px-2 py-0.5 text-xs text-kca-gray-100">
                You play {rep.colorToPlay}
              </span>
              <span className="rounded-md border border-kca-border bg-kca-surface-2 px-2 py-0.5 text-xs text-kca-gray-100">
                {variations.length} variations
              </span>
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <button type="button" className="btn-secondary py-2 text-sm" disabled={busy} onClick={toggleSave}>
              {rep.saved ? "★ Saved" : "☆ Save"}
            </button>
            {rep.hasPdf && (
              <>
                <a
                  className="btn-secondary py-2 text-sm"
                  href={`/api/opening/${id}/download?view=1`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  View PDF
                </a>
                <a className="btn-secondary py-2 text-sm" href={`/api/opening/${id}/download`}>
                  Download PDF
                </a>
              </>
            )}
            <button type="button" className="btn-secondary py-2 text-sm" disabled={busy} onClick={regenerate}>
              Regenerate
            </button>
          </div>
        </div>
      </div>

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_400px]">
        {/* Left: variations + coach's guide */}
        <div className="order-2 min-w-0 space-y-6 lg:order-1">
          <section className="card">
            <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-kca-gray-400">Variations</h2>
            <ul className="-mx-1 space-y-0.5">
              {variations.map((v, i) => {
                const isBest = rep.artifact?.bestLineIndex === i;
                const active = selected === i;
                return (
                  <li key={`${v.eco}-${v.name}-${i}`}>
                    <button
                      type="button"
                      onClick={() => selectVariation(i)}
                      className={`grid w-full grid-cols-[1.75rem_minmax(0,1fr)_auto] items-center gap-2 rounded-lg border-l-2 px-2 py-2 text-left text-sm transition ${
                        active
                          ? "border-kca-cyan bg-kca-surface-3 text-kca-white"
                          : "border-transparent text-kca-gray-100 hover:border-kca-border-bright hover:bg-kca-surface-2"
                      }`}
                    >
                      <span className="font-mono text-xs text-kca-gray-500">{i + 1}</span>
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="truncate">{v.name}</span>
                        {isBest && (
                          <span className="shrink-0 rounded bg-kca-cyan px-1.5 py-0.5 text-[10px] font-semibold text-black">
                            BEST
                          </span>
                        )}
                        {v.tag === "gambit" && (
                          <span className="shrink-0 rounded bg-kca-warning/20 px-1.5 py-0.5 text-[10px] text-kca-warning">
                            gambit
                          </span>
                        )}
                        {v.tag === "trap" && (
                          <span className="shrink-0 rounded bg-kca-danger/20 px-1.5 py-0.5 text-[10px] text-kca-danger">
                            trap
                          </span>
                        )}
                      </span>
                      <span className="font-mono text-xs tabular-nums text-kca-gray-500">{v.eco}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>

          <section className="card">
            <h2 className="mb-4 text-xs font-semibold uppercase tracking-wider text-kca-gray-400">Coach&apos;s guide</h2>
            <Markdown text={rep.guide ?? ""} />
          </section>
        </div>

        {/* Right: board, stepper, move list, explanation */}
        <div className="order-1 lg:order-2 lg:sticky lg:top-6">
          <div className="card space-y-3">
            <ChessBoard
              fen={fens[safePly]}
              orientation={orientation}
              onMove={() => {}}
              disabled
              lastMove={safePly > 0 ? ucis[safePly - 1] : undefined}
            />

            <div className="flex items-center gap-1.5">
              <button type="button" aria-label="Start" className={stepBtn} disabled={safePly === 0} onClick={() => setPly(0)}>
                ⏮
              </button>
              <button
                type="button"
                aria-label="Previous move"
                className={stepBtn}
                disabled={safePly === 0}
                onClick={() => setPly((p) => Math.max(0, p - 1))}
              >
                ◀
              </button>
              <span className="flex-1 whitespace-nowrap text-center font-mono text-xs tabular-nums text-kca-gray-400">
                {safePly === 0 ? "start" : `${Math.ceil(safePly / 2)}${safePly % 2 ? "." : "..."} ${moves[safePly - 1] ?? ""}`}
              </span>
              <button
                type="button"
                aria-label="Next move"
                className={stepBtn}
                disabled={safePly >= maxPly}
                onClick={() => setPly((p) => Math.min(maxPly, p + 1))}
              >
                ▶
              </button>
              <button type="button" aria-label="End" className={stepBtn} disabled={safePly >= maxPly} onClick={() => setPly(maxPly)}>
                ⏭
              </button>
            </div>

            {/* Score sheet — numbered pairs, so moves line up in columns. */}
            <div className="max-h-44 overflow-y-auto rounded-lg border border-kca-border bg-kca-black p-2">
              <div className="flex flex-wrap gap-x-1 gap-y-0.5 font-mono text-xs">
                {pairs.map((p) => (
                  <span key={p.no} className="inline-flex items-center gap-1">
                    <span className="tabular-nums text-kca-gray-500">{p.no}.</span>
                    {p.white && (
                      <button
                        type="button"
                        onClick={() => setPly(p.wi)}
                        className={`rounded px-1 transition ${
                          safePly === p.wi ? "bg-kca-cyan text-black" : "text-kca-gray-100 hover:bg-kca-surface-3"
                        } ${bookEnd !== undefined && p.wi > bookEnd ? "opacity-60" : ""}`}
                      >
                        {p.white}
                      </button>
                    )}
                    {p.black && (
                      <button
                        type="button"
                        onClick={() => setPly(p.bi)}
                        className={`rounded px-1 transition ${
                          safePly === p.bi ? "bg-kca-cyan text-black" : "text-kca-gray-100 hover:bg-kca-surface-3"
                        } ${bookEnd !== undefined && p.bi > bookEnd ? "opacity-60" : ""}`}
                      >
                        {p.black}
                      </button>
                    )}
                  </span>
                ))}
              </div>
            </div>

            {bookEnd !== undefined && (
              <p className="flex items-start gap-1.5 text-[11px] leading-snug text-kca-gray-500">
                <span className="mt-0.5 inline-block h-2 w-2 shrink-0 rounded-full bg-kca-gray-600" />
                Popular human play to move {Math.ceil(bookEnd / 2)}; the faded moves are the engine&apos;s continuation.
              </p>
            )}

            {/*
              At the start of a line this button used to be `disabled` while
              still wearing `btn-primary` — full-brightness cyan, indistinguishable
              from a live button, with a label that reads as an instruction. A real
              user clicked it, nothing happened, and reported the click as broken.
              They were right: a control that looks pressable and does nothing IS
              broken, whatever the `disabled` attribute says.

              So it now does the thing its label describes. From the start it
              advances to the first move and explains that; anywhere else it
              explains the move just played. It is only ever disabled while a
              request is actually in flight, and then it says so.
            */}
            <button
              type="button"
              className="btn-primary w-full py-2.5"
              disabled={explaining || maxPly < 1}
              onClick={() => {
                if (safePly < 1) {
                  setPly(1);
                  void explainCurrent(1);
                } else {
                  void explainCurrent(safePly);
                }
              }}
            >
              {explaining
                ? "Explaining…"
                : safePly < 1
                  ? `Play ${moves[0] ?? "the first move"} and explain it`
                  : `Explain ${moves[safePly - 1] ?? ""}`}
            </button>

            {explanation && (
              <div className="rounded-lg border border-kca-cyan/30 bg-kca-cyan/5 p-3">
                <div className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-kca-cyan">
                  <span className="inline-block h-1.5 w-1.5 rounded-full bg-kca-cyan" />
                  AI coach · engine-verified
                </div>
                <Markdown text={explanation} className="text-kca-gray-100" />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
