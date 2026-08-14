"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Chess } from "chess.js";
import {
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  FlipVertical2,
  Loader2,
  ScanLine,
  X,
} from "lucide-react";
import ChessBoard from "@/components/chess/ChessBoard";
import EvalBar from "@/components/chess/EvalBar";
import EngineLines from "@/components/analysis/EngineLines";
import AnalysisMoveList from "@/components/analysis/AnalysisMoveList";
import ExplainPanel, { type ExplainParams } from "@/components/analysis/ExplainPanel";
import ImportPanel from "@/components/analysis/ImportPanel";
import { useStockfish } from "@/hooks/useStockfish";
import {
  START_FEN,
  buildLine,
  buildLineFromPgn,
  buildMoveAnalyses,
  fenAtPly,
  sanForUci,
  summariseAccuracy,
  type MoveAnalysis,
  type PositionNode,
  type ScoredPosition,
} from "@/lib/engine/analysis";
import { CLASSIFICATION_META, type MoveClassification } from "@/lib/engine/classify";
import { pvToSan, scoreFromLine } from "@/lib/engine/uci";
import { cn } from "@/lib/utils";

/** Depth used for the sequential full-game sweep. */
const SCAN_DEPTH = 14;
/** Depth used for the one-off search behind "Explain move". */
const EXPLAIN_DEPTH = 16;
const MULTIPV = 3;

type Loaded = {
  rootFen: string;
  nodes: PositionNode[];
  label: string | null;
};

export default function AnalysisBoardClient() {
  const searchParams = useSearchParams();
  const gameId = searchParams.get("gameId");
  // Play-vs-engine hands its finished game over this way.
  const pgnParam = searchParams.get("pgn");

  const [rootFen, setRootFen] = useState(START_FEN);
  const [nodes, setNodes] = useState<PositionNode[]>([]);
  const [currentPly, setCurrentPly] = useState(0);
  const [orientation, setOrientation] = useState<"white" | "black">("white");
  const [sourceLabel, setSourceLabel] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isLoadingGame, setIsLoadingGame] = useState(Boolean(gameId));

  const [analyses, setAnalyses] = useState<MoveAnalysis[]>([]);
  const [scanProgress, setScanProgress] = useState<{ done: number; total: number } | null>(null);
  const scanCancelRef = useRef(false);

  const engine = useStockfish({ multipv: MULTIPV });
  const { isReady, isAnalyzing, lines, analyze, startInfinite, stop, stopInfinite, newGame, engineLabel } =
    engine;

  const currentFen = useMemo(() => fenAtPly(rootFen, nodes, currentPly), [rootFen, nodes, currentPly]);
  const isScanning = scanProgress !== null;

  const applyLoaded = useCallback(
    ({ rootFen: fen, nodes: loadedNodes, label }: Loaded) => {
      setRootFen(fen);
      setNodes(loadedNodes);
      setCurrentPly(loadedNodes.length);
      setSourceLabel(label);
      setAnalyses([]);
      setLoadError(null);
      newGame();
    },
    [newGame],
  );

  // ---- Entry point: a finished game from the history page -----------------
  useEffect(() => {
    if (!gameId) return;
    let active = true;

    const load = async () => {
      setIsLoadingGame(true);
      try {
        const response = await fetch(`/api/games/${gameId}`);
        const data = await response.json();
        if (!active) return;

        if (!response.ok || !data.success || !data.game) {
          setLoadError(data.message ?? "Could not load that game.");
          return;
        }

        const moves: string[] = Array.isArray(data.game.moves) ? data.game.moves : [];
        const loadedNodes = buildLine(START_FEN, moves);
        if (loadedNodes.length === 0) {
          setLoadError("That game has no moves to analyse.");
          return;
        }

        const white = data.game.whiteUser?.username ?? "White";
        const black = data.game.blackUser?.username ?? "Black";
        applyLoaded({
          rootFen: START_FEN,
          nodes: loadedNodes,
          label: `${white} vs ${black}`,
        });
      } catch {
        if (active) setLoadError("Could not load that game.");
      } finally {
        if (active) setIsLoadingGame(false);
      }
    };

    void load();
    return () => {
      active = false;
    };
  }, [gameId, applyLoaded]);

  // ---- Entry point: a PGN handed over in the URL --------------------------
  // Parsing is pure, so it is derived during render. Only loading the result
  // into the board is a side effect, and a parse failure is derived state
  // rather than something to store.
  const parsedPgn = useMemo(() => (pgnParam ? buildLineFromPgn(pgnParam) : null), [pgnParam]);
  const pgnError = pgnParam && !parsedPgn ? "That PGN could not be read." : null;

  // Loading the parsed line is a state adjustment, so it happens during render
  // — no extra commit, and the board never shows a frame of the old position.
  // Resetting the engine is the one genuine side effect and stays in an effect.
  const [appliedPgn, setAppliedPgn] = useState<string | null>(null);
  if (parsedPgn && pgnParam !== appliedPgn) {
    setAppliedPgn(pgnParam);
    setRootFen(parsedPgn.rootFen);
    setNodes(parsedPgn.nodes);
    setCurrentPly(parsedPgn.nodes.length);
    setSourceLabel("Engine game");
    setAnalyses([]);
    setLoadError(null);
  }

  useEffect(() => {
    if (appliedPgn) newGame();
  }, [appliedPgn, newGame]);

  // ---- Live evaluation of the position on the board -----------------------
  useEffect(() => {
    if (!isReady || isScanning) return;
    startInfinite(currentFen, MULTIPV);
    // Only the live search is torn down here — this cleanup fires after a
    // full-game scan has already queued its first request.
    return () => stopInfinite();
  }, [isReady, isScanning, currentFen, startInfinite, stopInfinite]);

  // ---- Navigation ---------------------------------------------------------
  const goToPly = useCallback(
    (ply: number) => setCurrentPly(Math.max(0, Math.min(nodes.length, ply))),
    [nodes.length],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;

      if (event.key === "ArrowLeft") goToPly(currentPly - 1);
      else if (event.key === "ArrowRight") goToPly(currentPly + 1);
      else if (event.key === "Home") goToPly(0);
      else if (event.key === "End") goToPly(nodes.length);
      else return;

      event.preventDefault();
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [currentPly, nodes.length, goToPly]);

  // ---- Playing moves on the board ----------------------------------------
  const handleMove = useCallback(
    (from: string, to: string, promotion?: string) => {
      if (isScanning) return;

      const chess = new Chess(currentFen);
      let move;
      try {
        move = chess.move({ from, to, promotion: promotion ?? "q" });
      } catch {
        return;
      }
      if (!move) return;

      // Playing from an earlier position replaces the rest of the line. The
      // loaded game can be restored from the import panel.
      const kept = nodes.slice(0, currentPly);
      const node: PositionNode = {
        ply: currentPly + 1,
        fen: chess.fen(),
        fenBefore: currentFen,
        san: move.san,
        uci: `${move.from}${move.to}${move.promotion ?? ""}`,
        mover: move.color,
      };

      setNodes([...kept, node]);
      setCurrentPly(currentPly + 1);
      // Classifications no longer describe the line on screen.
      if (kept.length !== nodes.length) setAnalyses([]);
    },
    [currentFen, currentPly, nodes, isScanning],
  );

  const playEngineLine = useCallback(
    (pv: string[]) => {
      const first = pv[0];
      if (!first) return;
      handleMove(first.slice(0, 2), first.slice(2, 4), first.length > 4 ? first[4] : undefined);
    },
    [handleMove],
  );

  // ---- Import handlers ----------------------------------------------------
  const handleLoadPgn = useCallback(
    (pgn: string) => {
      const parsed = buildLineFromPgn(pgn);
      if (!parsed) return "That does not look like a valid PGN.";
      applyLoaded({ rootFen: parsed.rootFen, nodes: parsed.nodes, label: "Imported PGN" });
      return null;
    },
    [applyLoaded],
  );

  const handleLoadFen = useCallback(
    (fen: string) => {
      try {
        new Chess(fen);
      } catch {
        return "That does not look like a valid FEN.";
      }
      applyLoaded({ rootFen: fen, nodes: [], label: "Imported position" });
      return null;
    },
    [applyLoaded],
  );

  const handleReset = useCallback(() => {
    applyLoaded({ rootFen: START_FEN, nodes: [], label: null });
  }, [applyLoaded]);

  // ---- Full-game scan -----------------------------------------------------
  const runFullScan = useCallback(async () => {
    if (nodes.length === 0 || !isReady) return;

    scanCancelRef.current = false;
    stop();
    newGame();

    const total = nodes.length + 1;
    setScanProgress({ done: 0, total });
    setAnalyses([]);

    const scores: ScoredPosition[] = [];
    try {
      for (let index = 0; index < total; index += 1) {
        if (scanCancelRef.current) return;

        const fen = index === 0 ? rootFen : nodes[index - 1].fen;
        const result = await analyze({ fen, depth: SCAN_DEPTH, multipv: 1 });
        const score = scoreFromLine(result.lines[0]);
        scores.push({ cp: score.cp, mate: score.mate, bestMove: result.bestMove });
        setScanProgress({ done: index + 1, total });
      }

      if (!scanCancelRef.current) {
        setAnalyses(buildMoveAnalyses(nodes, scores));
      }
    } finally {
      setScanProgress(null);
    }
  }, [nodes, rootFen, isReady, analyze, stop, newGame]);

  const cancelScan = useCallback(() => {
    scanCancelRef.current = true;
    stop();
  }, [stop]);

  // ---- Derived view state -------------------------------------------------
  const classifications = useMemo(() => {
    const map = new Map<number, MoveClassification>();
    for (const analysis of analyses) map.set(analysis.ply, analysis.classification);
    return map;
  }, [analyses]);

  const accuracy = useMemo(
    () => (analyses.length > 0 ? summariseAccuracy(analyses, nodes) : null),
    [analyses, nodes],
  );

  const topLine = lines[0];
  const bestMoveUci = topLine?.pv[0];
  const arrows = useMemo(
    () =>
      bestMoveUci && !isScanning
        ? [
            {
              startSquare: bestMoveUci.slice(0, 2),
              endSquare: bestMoveUci.slice(2, 4),
              color: "rgba(0, 200, 232, 0.65)",
            },
          ]
        : [],
    [bestMoveUci, isScanning],
  );

  const currentNode = currentPly > 0 ? nodes[currentPly - 1] : null;
  const currentAnalysis = analyses.find((entry) => entry.ply === currentPly) ?? null;

  /**
   * Builds the payload for /api/analysis/explain. The engine's opinion is taken
   * at the position *before* the played move, so the explanation compares what
   * was played against what the engine wanted there.
   */
  const buildExplainParams = useCallback(async (): Promise<ExplainParams | null> => {
    if (!currentNode || !isReady) return null;

    // Submitting supersedes the live search; restart it afterwards so the eval
    // bar does not freeze once the explanation has what it needs.
    const result = await analyze({
      fen: currentNode.fenBefore,
      depth: EXPLAIN_DEPTH,
      multipv: MULTIPV,
    });
    startInfinite(currentFen, MULTIPV);

    if (!result.bestMove) return null;

    const bestScore = scoreFromLine(result.lines[0]);
    const bestMoveSan = sanForUci(currentNode.fenBefore, result.bestMove);

    return {
      fen: currentNode.fenBefore,
      playerMoveSan: currentNode.san,
      bestMoveSan: bestMoveSan || currentNode.san,
      evaluation: bestScore.cp ?? (bestScore.mate ?? 0) * 1000,
      topMoves: result.lines.slice(0, 3).map((line) => {
        const san = pvToSan(currentNode.fenBefore, line.pv, 6);
        return {
          san: san[0] ?? "",
          evaluation: line.cp ?? (line.mate ?? 0) * 1000,
          continuation: san.slice(1).join(" "),
        };
      }),
      isGoodMove: currentAnalysis
        ? ["best", "excellent", "good"].includes(currentAnalysis.classification)
        : result.bestMove === currentNode.uci,
    };
  }, [currentNode, currentAnalysis, currentFen, isReady, analyze, startInfinite]);

  const scanPercent = scanProgress
    ? Math.round((scanProgress.done / scanProgress.total) * 100)
    : 0;

  return (
    <div className="w-full max-w-6xl mx-auto">
      <div className="mb-6">
        <h1 className="text-3xl font-display font-bold text-kca-white mb-2">Analysis Board</h1>
        <p className="text-sm text-kca-gray-400">
          {sourceLabel ? (
            <>
              Analysing <span className="text-kca-gray-100">{sourceLabel}</span> · powered by{" "}
              {engineLabel}
            </>
          ) : (
            <>Explore any position with {engineLabel} and ask your AI coach why.</>
          )}
        </p>
      </div>

      {(loadError ?? pgnError) && (
        <div className="mb-4 rounded-xl border border-kca-danger/30 bg-kca-danger/10 px-4 py-3 text-sm text-kca-danger">
          {loadError ?? pgnError}
        </div>
      )}

      <div className="flex flex-col lg:flex-row gap-6 items-start">
        {/* Board column */}
        <div className="w-full max-w-[600px] mx-auto lg:mx-0">
          <div className="flex gap-2">
            <EvalBar
              cp={topLine?.cp ?? null}
              mate={topLine?.mate ?? null}
              orientation={orientation}
              isReady={isReady}
            />

            <div className="flex-1 aspect-square bg-kca-surface border border-kca-border rounded-2xl overflow-hidden p-1.5">
              {isLoadingGame ? (
                <div className="w-full h-full flex items-center justify-center">
                  <Loader2 className="w-8 h-8 animate-spin text-kca-cyan" />
                </div>
              ) : (
                <ChessBoard
                  fen={currentFen}
                  orientation={orientation}
                  onMove={handleMove}
                  disabled={isScanning}
                  lastMove={currentNode?.uci}
                  arrows={arrows}
                />
              )}
            </div>
          </div>

          {/* Navigation */}
          <div className="flex items-center justify-between gap-2 mt-3">
            <div className="flex items-center gap-1">
              {[
                { icon: ChevronsLeft, action: () => goToPly(0), label: "Start" },
                { icon: ChevronLeft, action: () => goToPly(currentPly - 1), label: "Previous" },
                { icon: ChevronRight, action: () => goToPly(currentPly + 1), label: "Next" },
                { icon: ChevronsRight, action: () => goToPly(nodes.length), label: "End" },
              ].map(({ icon: Icon, action, label }) => (
                <button
                  key={label}
                  type="button"
                  onClick={action}
                  aria-label={label}
                  disabled={nodes.length === 0}
                  className="btn-secondary p-2 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <Icon className="w-4 h-4" />
                </button>
              ))}
            </div>

            <div className="flex items-center gap-2">
              <span className="text-[11px] font-mono text-kca-gray-400">
                {currentPly}/{nodes.length}
              </span>
              <button
                type="button"
                onClick={() => setOrientation((side) => (side === "white" ? "black" : "white"))}
                aria-label="Flip board"
                className="btn-secondary p-2"
              >
                <FlipVertical2 className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>

        {/* Side panel */}
        <div className="w-full lg:w-[360px] flex flex-col gap-4">
          <EngineLines
            lines={lines}
            fen={currentFen}
            isReady={isReady}
            isAnalyzing={isAnalyzing}
            engineLabel={engineLabel}
            onPlayLine={playEngineLine}
          />

          {/* Full-game scan */}
          <div className="card p-4 bg-kca-surface border border-kca-border">
            <div className="flex items-center justify-between gap-2 mb-3">
              <div className="flex items-center gap-2">
                <ScanLine className="w-4 h-4 text-kca-cyan" />
                <span className="text-[11px] uppercase tracking-wider text-kca-gray-400">
                  Full game review
                </span>
              </div>
              {isScanning ? (
                <button
                  type="button"
                  onClick={cancelScan}
                  className="flex items-center gap-1 text-[11px] text-kca-danger hover:text-kca-white transition-colors"
                >
                  <X className="w-3 h-3" />
                  Cancel
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => void runFullScan()}
                  disabled={nodes.length === 0 || !isReady}
                  className="btn-secondary py-1.5 px-3 text-xs disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Analyse game
                </button>
              )}
            </div>

            {isScanning ? (
              <div>
                <div className="h-1.5 w-full rounded-full bg-kca-black overflow-hidden">
                  <div
                    className="h-full bg-kca-cyan transition-[width] duration-200"
                    style={{ width: `${scanPercent}%` }}
                  />
                </div>
                <p className="mt-2 text-[11px] font-mono text-kca-gray-400">
                  {scanProgress?.done}/{scanProgress?.total} positions · depth {SCAN_DEPTH}
                </p>
              </div>
            ) : accuracy ? (
              <div className="flex flex-col gap-3">
                <div className="grid grid-cols-2 gap-3">
                  {(
                    [
                      ["White", accuracy.white],
                      ["Black", accuracy.black],
                    ] as const
                  ).map(([label, side]) => (
                    <div key={label} className="rounded-lg bg-kca-black/40 px-3 py-2">
                      <p className="text-[10px] uppercase tracking-wider text-kca-gray-400">
                        {label}
                      </p>
                      <p className="text-xl font-mono font-bold text-kca-white">
                        {side.accuracy.toFixed(1)}%
                      </p>
                      <p className="text-[10px] text-kca-gray-400 mt-0.5">
                        {side.counts.blunder} blunders · {side.counts.mistake} mistakes
                      </p>
                    </div>
                  ))}
                </div>
                <p className="text-[10px] text-kca-gray-600 leading-relaxed">
                  Review results live in this tab only — reloading the page runs the scan again.
                </p>
              </div>
            ) : (
              <p className="text-sm text-kca-gray-400">
                {nodes.length === 0
                  ? "Import a game to review every move."
                  : `Scores all ${nodes.length + 1} positions at depth ${SCAN_DEPTH} and grades each move.`}
              </p>
            )}
          </div>

          {/* Current move verdict */}
          {currentAnalysis && (
            <div
              className={cn(
                "card p-4 border",
                CLASSIFICATION_META[currentAnalysis.classification].bgClass,
              )}
            >
              <div className="flex items-baseline justify-between gap-2">
                <span
                  className={cn(
                    "text-sm font-bold",
                    CLASSIFICATION_META[currentAnalysis.classification].textClass,
                  )}
                >
                  {currentAnalysis.playedSan} —{" "}
                  {CLASSIFICATION_META[currentAnalysis.classification].label}
                </span>
                <span className="text-[11px] font-mono text-kca-gray-400">
                  {currentAnalysis.accuracy.toFixed(0)}%
                </span>
              </div>
              {currentAnalysis.cpLoss > 0 && currentAnalysis.bestMoveSan && (
                <p className="mt-1 text-xs text-kca-gray-100">
                  Engine preferred{" "}
                  <span className="font-mono text-kca-cyan">{currentAnalysis.bestMoveSan}</span> —
                  lost {(currentAnalysis.cpLoss / 100).toFixed(2)} pawns.
                </p>
              )}
            </div>
          )}

          <ExplainPanel
            // Remounting on position change is what clears the previous explanation.
            key={`${currentFen}:${currentPly}`}
            buildParams={buildExplainParams}
            disabled={!isReady || !currentNode || isScanning}
          />

          <AnalysisMoveList
            nodes={nodes}
            currentPly={currentPly}
            onSelectPly={goToPly}
            classifications={classifications}
          />

          <ImportPanel
            onLoadPgn={handleLoadPgn}
            onLoadFen={handleLoadFen}
            onReset={handleReset}
          />
        </div>
      </div>
    </div>
  );
}
