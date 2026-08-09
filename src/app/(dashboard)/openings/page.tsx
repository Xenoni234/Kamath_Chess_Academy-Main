"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Chess } from "chess.js";
import { ChevronLeft, FlipVertical2, Loader2, Map as MapIcon, RotateCcw } from "lucide-react";
import ChessBoard from "@/components/chess/ChessBoard";
import { START_FEN, type PositionNode } from "@/lib/engine/analysis";
import { uciToMove } from "@/lib/engine/uci";
import { cn } from "@/lib/utils";

/**
 * Lichess opening explorer over the platform's cached proxy
 * (GET /api/analysis/opening — Postgres-backed, 24 h TTL).
 */

type ExplorerMove = {
  uci: string;
  san: string;
  white: number;
  draws: number;
  black: number;
  averageRating?: number | null;
};

type ExplorerResponse = {
  white: number;
  draws: number;
  black: number;
  moves: ExplorerMove[];
  opening?: { eco: string; name: string } | null;
};

const SPEED_OPTIONS = ["bullet", "blitz", "rapid", "classical"] as const;
const RATING_OPTIONS = ["1600", "1800", "2000", "2200", "2500"] as const;
const FETCH_DEBOUNCE_MS = 250;

export default function OpeningsPage() {
  const [nodes, setNodes] = useState<PositionNode[]>([]);
  const [orientation, setOrientation] = useState<"white" | "black">("white");
  const [speeds, setSpeeds] = useState<string[]>(["blitz", "rapid", "classical"]);
  const [ratings, setRatings] = useState<string[]>(["1800", "2000", "2200"]);

  const [data, setData] = useState<ExplorerResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Responses are cached per request key so stepping back is instant.
  const cacheRef = useRef(new Map<string, ExplorerResponse>());

  const fen = nodes.length > 0 ? nodes[nodes.length - 1].fen : START_FEN;
  const requestKey = useMemo(
    () => `${fen}|${speeds.join(",")}|${ratings.join(",")}`,
    [fen, speeds, ratings],
  );

  useEffect(() => {
    const cached = cacheRef.current.get(requestKey);
    if (cached) {
      setData(cached);
      setError(null);
      setIsLoading(false);
      return;
    }

    const controller = new AbortController();
    setIsLoading(true);

    const timer = setTimeout(() => {
      const params = new URLSearchParams({
        fen,
        speeds: speeds.join(","),
        ratings: ratings.join(","),
      });

      fetch(`/api/analysis/opening?${params.toString()}`, { signal: controller.signal })
        .then(async (response) => {
          const payload = await response.json();
          if (!response.ok || !payload.success) {
            setError(payload.message ?? "Could not load opening statistics.");
            setData(null);
            return;
          }
          cacheRef.current.set(requestKey, payload.explorer);
          setData(payload.explorer);
          setError(null);
        })
        .catch((fetchError: Error) => {
          if (fetchError.name !== "AbortError") {
            setError("Could not load opening statistics.");
            setData(null);
          }
        })
        .finally(() => {
          if (!controller.signal.aborted) setIsLoading(false);
        });
    }, FETCH_DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [requestKey, fen, speeds, ratings]);

  const playMove = useCallback(
    (from: string, to: string, promotion?: string) => {
      const chess = new Chess(fen);
      let move;
      try {
        move = chess.move({ from, to, promotion: promotion ?? "q" });
      } catch {
        return;
      }
      if (!move) return;

      setNodes((current) => [
        ...current,
        {
          ply: current.length + 1,
          fen: chess.fen(),
          fenBefore: fen,
          san: move.san,
          uci: `${move.from}${move.to}${move.promotion ?? ""}`,
          mover: move.color,
        },
      ]);
    },
    [fen],
  );

  const playUci = useCallback(
    (uci: string) => {
      const { from, to, promotion } = uciToMove(uci);
      playMove(from, to, promotion);
    },
    [playMove],
  );

  const stepBack = useCallback(() => setNodes((current) => current.slice(0, -1)), []);
  const reset = useCallback(() => setNodes([]), []);

  const toggle = (list: string[], value: string, setter: (next: string[]) => void) => {
    const next = list.includes(value) ? list.filter((entry) => entry !== value) : [...list, value];
    // The API requires at least one of each filter.
    if (next.length > 0) setter(next);
  };

  const totalGames = data ? data.white + data.draws + data.black : 0;

  return (
    <div className="w-full max-w-6xl mx-auto">
      <div className="mb-6">
        <h1 className="text-3xl font-display font-bold text-kca-white mb-2">Opening Explorer</h1>
        <p className="text-sm text-kca-gray-400">
          What real players do in this position, from the Lichess games database.
        </p>
      </div>

      <div className="flex flex-col lg:flex-row gap-6 items-start">
        {/* Board column */}
        <div className="w-full max-w-[520px] mx-auto lg:mx-0">
          <div className="aspect-square bg-kca-surface border border-kca-border rounded-2xl overflow-hidden p-1.5">
            <ChessBoard
              fen={fen}
              orientation={orientation}
              onMove={playMove}
              lastMove={nodes[nodes.length - 1]?.uci}
            />
          </div>

          <div className="flex items-center justify-between gap-2 mt-3">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={stepBack}
                disabled={nodes.length === 0}
                className="btn-secondary py-2 px-3 text-xs flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <ChevronLeft className="w-4 h-4" />
                Back
              </button>
              <button
                type="button"
                onClick={reset}
                disabled={nodes.length === 0}
                className="btn-secondary py-2 px-3 text-xs flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <RotateCcw className="w-4 h-4" />
                Reset
              </button>
            </div>
            <button
              type="button"
              onClick={() => setOrientation((side) => (side === "white" ? "black" : "white"))}
              aria-label="Flip board"
              className="btn-secondary p-2"
            >
              <FlipVertical2 className="w-4 h-4" />
            </button>
          </div>

          {/* Line breadcrumb */}
          <div className="card p-3 mt-3 bg-kca-surface border border-kca-border">
            <p className="text-[10px] uppercase tracking-wider text-kca-gray-400 mb-1.5">Line</p>
            {nodes.length === 0 ? (
              <p className="text-sm text-kca-gray-400">Starting position</p>
            ) : (
              <p className="font-mono text-sm text-kca-gray-100 leading-relaxed">
                {nodes.map((node, index) => (
                  <span key={node.ply}>
                    {node.mover === "w" && `${Math.floor(index / 2) + 1}. `}
                    <button
                      type="button"
                      onClick={() => setNodes(nodes.slice(0, index + 1))}
                      className="hover:text-kca-cyan transition-colors"
                    >
                      {node.san}
                    </button>{" "}
                  </span>
                ))}
              </p>
            )}
            {data?.opening && (
              <p className="mt-2 text-xs text-kca-cyan">
                <span className="font-mono">{data.opening.eco}</span> · {data.opening.name}
              </p>
            )}
          </div>
        </div>

        {/* Stats column */}
        <div className="w-full lg:flex-1 flex flex-col gap-4">
          {/* Filters */}
          <div className="card p-4 bg-kca-surface border border-kca-border">
            <div className="flex items-center gap-2 mb-3">
              <MapIcon className="w-4 h-4 text-kca-cyan" />
              <span className="text-[11px] uppercase tracking-wider text-kca-gray-400">Filters</span>
            </div>

            <p className="text-[10px] uppercase tracking-wider text-kca-gray-600 mb-1.5">Speed</p>
            <div className="flex flex-wrap gap-1.5 mb-3">
              {SPEED_OPTIONS.map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => toggle(speeds, option, setSpeeds)}
                  className={cn(
                    "px-2.5 py-1 rounded-lg text-[11px] capitalize border transition-colors",
                    speeds.includes(option)
                      ? "border-kca-cyan bg-kca-cyan/10 text-kca-cyan"
                      : "border-kca-border text-kca-gray-400 hover:border-kca-border-hover",
                  )}
                >
                  {option}
                </button>
              ))}
            </div>

            <p className="text-[10px] uppercase tracking-wider text-kca-gray-600 mb-1.5">Rating</p>
            <div className="flex flex-wrap gap-1.5">
              {RATING_OPTIONS.map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => toggle(ratings, option, setRatings)}
                  className={cn(
                    "px-2.5 py-1 rounded-lg text-[11px] font-mono border transition-colors",
                    ratings.includes(option)
                      ? "border-kca-cyan bg-kca-cyan/10 text-kca-cyan"
                      : "border-kca-border text-kca-gray-400 hover:border-kca-border-hover",
                  )}
                >
                  {option}+
                </button>
              ))}
            </div>
          </div>

          {/* Moves table */}
          <div className="card p-0 bg-kca-surface border border-kca-border rounded-xl overflow-hidden">
            <div className="flex items-baseline justify-between px-4 py-2.5 border-b border-kca-border">
              <span className="text-[11px] uppercase tracking-wider text-kca-gray-400">
                Popular moves
              </span>
              {totalGames > 0 && (
                <span className="text-[11px] font-mono text-kca-gray-400">
                  {totalGames.toLocaleString()} games
                </span>
              )}
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-sm text-left">
                <thead className="text-[10px] text-kca-gray-400 bg-kca-black/50 uppercase tracking-wider border-b border-kca-border">
                  <tr>
                    <th className="px-4 py-2.5 font-semibold">Move</th>
                    <th className="px-4 py-2.5 font-semibold text-right">Games</th>
                    <th className="px-4 py-2.5 font-semibold text-right">Rating</th>
                    <th className="px-4 py-2.5 font-semibold w-[40%]">White / Draw / Black</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-kca-border/50">
                  {isLoading && (
                    <tr>
                      <td colSpan={4} className="px-4 py-10 text-center text-kca-gray-500">
                        <Loader2 className="w-5 h-5 mx-auto mb-2 animate-spin text-kca-cyan" />
                        <p className="text-xs">Loading statistics…</p>
                      </td>
                    </tr>
                  )}

                  {!isLoading && error && (
                    <tr>
                      <td colSpan={4} className="px-4 py-10 text-center text-sm text-kca-danger">
                        {error}
                      </td>
                    </tr>
                  )}

                  {!isLoading && !error && data?.moves.length === 0 && (
                    <tr>
                      <td colSpan={4} className="px-4 py-10 text-center text-sm text-kca-gray-500">
                        No games reach this position with the current filters.
                      </td>
                    </tr>
                  )}

                  {!isLoading &&
                    !error &&
                    data?.moves.map((move) => {
                      const total = move.white + move.draws + move.black || 1;
                      const white = (move.white / total) * 100;
                      const draws = (move.draws / total) * 100;
                      const black = (move.black / total) * 100;

                      return (
                        <tr
                          key={move.uci}
                          onClick={() => playUci(move.uci)}
                          className="hover:bg-kca-surface-2 transition-colors cursor-pointer"
                        >
                          <td className="px-4 py-2.5 font-mono font-bold text-kca-white">
                            {move.san}
                          </td>
                          <td className="px-4 py-2.5 text-right font-mono text-kca-gray-100">
                            {total.toLocaleString()}
                          </td>
                          <td className="px-4 py-2.5 text-right font-mono text-kca-gray-400">
                            {move.averageRating ?? "—"}
                          </td>
                          <td className="px-4 py-2.5">
                            <div className="flex h-4 w-full rounded overflow-hidden text-[9px] font-bold">
                              <div
                                className="bg-[#EEEED2] text-[#333] flex items-center justify-center"
                                style={{ width: `${white}%` }}
                              >
                                {white >= 15 ? `${Math.round(white)}%` : ""}
                              </div>
                              <div
                                className="bg-kca-gray-600 text-kca-white flex items-center justify-center"
                                style={{ width: `${draws}%` }}
                              >
                                {draws >= 15 ? `${Math.round(draws)}%` : ""}
                              </div>
                              <div
                                className="bg-[#403d39] text-kca-white flex items-center justify-center"
                                style={{ width: `${black}%` }}
                              >
                                {black >= 15 ? `${Math.round(black)}%` : ""}
                              </div>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
