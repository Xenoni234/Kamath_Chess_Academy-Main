"use client";

import { formatEval } from "@/lib/engine/uci";
import { winPercentFromScore } from "@/lib/engine/classify";
import { cn } from "@/lib/utils";

type EvalBarProps = {
  /** Centipawns from White's point of view. Null when `mate` is set. */
  cp: number | null;
  mate: number | null;
  /** Flips the bar so the player to the bottom of the board is at the bottom. */
  orientation: "white" | "black";
  /** Dim the bar while the engine is still starting up. */
  isReady?: boolean;
};

export default function EvalBar({ cp, mate, orientation, isReady = true }: EvalBarProps) {
  const whitePercent = winPercentFromScore(cp, mate);
  // The bar fills from the bottom with the colour that owns the board's near
  // side, so the "advantage" always grows towards the player.
  const nearSidePercent = orientation === "white" ? whitePercent : 100 - whitePercent;
  const label = formatEval(cp, mate);
  const favoursWhite = whitePercent >= 50;

  return (
    <div
      className={cn(
        "relative w-7 shrink-0 rounded-lg overflow-hidden border border-kca-border bg-kca-black transition-opacity duration-300",
        !isReady && "opacity-40",
      )}
      title={`Evaluation ${label}`}
    >
      {/* Far side (top) */}
      <div className="absolute inset-0 bg-[#1a1a1a]" />
      {/* Near side (bottom) grows upward */}
      <div
        className="absolute bottom-0 left-0 right-0 bg-[#EEEED2] transition-[height] duration-300 ease-out"
        style={{ height: `${Math.max(0, Math.min(100, nearSidePercent))}%` }}
      />
      {/* Midpoint marker */}
      <div className="absolute left-0 right-0 top-1/2 h-px bg-kca-cyan/40" />

      <span
        className={cn(
          "absolute left-0 right-0 text-[9px] font-mono font-bold text-center px-0.5",
          favoursWhite ? "bottom-1 text-[#333]" : "top-1 text-kca-white",
        )}
      >
        {label}
      </span>
    </div>
  );
}
