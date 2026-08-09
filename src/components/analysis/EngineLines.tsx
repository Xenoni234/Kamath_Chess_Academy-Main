"use client";

import { Cpu, Loader2 } from "lucide-react";
import { formatEval, pvToSan, type EngineLine } from "@/lib/engine/uci";
import { cn } from "@/lib/utils";

type EngineLinesProps = {
  lines: EngineLine[];
  /** Position the lines were produced for — needed to render the PV as SAN. */
  fen: string;
  isReady: boolean;
  isAnalyzing: boolean;
  engineLabel: string;
  /** Called with the PV in UCI when a line is clicked. */
  onPlayLine?: (pv: string[]) => void;
};

export default function EngineLines({
  lines,
  fen,
  isReady,
  isAnalyzing,
  engineLabel,
  onPlayLine,
}: EngineLinesProps) {
  const depth = lines[0]?.depth ?? 0;
  const nps = lines[0]?.nps;

  return (
    <div className="card p-4 bg-kca-surface border border-kca-border">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Cpu className="w-4 h-4 text-kca-cyan" />
          <span className="text-[11px] uppercase tracking-wider text-kca-gray-400">
            Engine
          </span>
        </div>
        <div className="flex items-center gap-2 text-[11px] font-mono text-kca-gray-400">
          {isAnalyzing && <Loader2 className="w-3 h-3 animate-spin text-kca-cyan" />}
          {depth > 0 && <span>depth {depth}</span>}
          {nps ? <span className="hidden sm:inline">{Math.round(nps / 1000)}kn/s</span> : null}
        </div>
      </div>

      {!isReady ? (
        <div className="flex items-center gap-2 py-3 text-sm text-kca-gray-400">
          <Loader2 className="w-4 h-4 animate-spin text-kca-cyan" />
          Loading {engineLabel}…
        </div>
      ) : lines.length === 0 ? (
        <p className="py-3 text-sm text-kca-gray-400">Evaluating position…</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {lines.map((line) => {
            const san = pvToSan(fen, line.pv, 10);
            const favoursWhite = (line.mate ?? line.cp ?? 0) >= 0;

            return (
              <li key={line.multipv}>
                <button
                  type="button"
                  onClick={() => onPlayLine?.(line.pv)}
                  disabled={line.pv.length === 0}
                  className={cn(
                    "w-full flex items-start gap-2 text-left rounded-lg px-2 py-1.5",
                    "hover:bg-kca-surface-2 transition-colors disabled:cursor-default",
                  )}
                >
                  <span
                    className={cn(
                      "shrink-0 font-mono text-xs font-bold px-1.5 py-0.5 rounded border",
                      favoursWhite
                        ? "text-kca-white bg-kca-gray-600/20 border-kca-gray-600/30"
                        : "text-kca-gray-100 bg-kca-black border-kca-border",
                    )}
                  >
                    {formatEval(line.cp, line.mate)}
                  </span>
                  <span className="font-mono text-xs text-kca-gray-100 leading-relaxed line-clamp-2">
                    {san.join(" ") || "—"}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
