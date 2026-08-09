"use client";

import { useEffect, useRef } from "react";
import { CLASSIFICATION_META, type MoveClassification } from "@/lib/engine/classify";
import type { PositionNode } from "@/lib/engine/analysis";
import { cn } from "@/lib/utils";

type AnalysisMoveListProps = {
  nodes: PositionNode[];
  /** 0 = root position, n = after the nth half-move. */
  currentPly: number;
  onSelectPly: (ply: number) => void;
  /** Populated once a full-game scan has run. */
  classifications?: Map<number, MoveClassification>;
};

export default function AnalysisMoveList({
  nodes,
  currentPly,
  onSelectPly,
  classifications,
}: AnalysisMoveListProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [currentPly]);

  // Pair half-moves into numbered rows. A line starting from a Black-to-move
  // FEN gets a leading "…" placeholder so the columns stay aligned.
  const rows: Array<{ number: number; white?: PositionNode; black?: PositionNode }> = [];
  for (const node of nodes) {
    const isWhiteMove = node.mover === "w";
    const last = rows[rows.length - 1];

    if (isWhiteMove || !last || last.black) {
      rows.push(
        isWhiteMove
          ? { number: rows.length + 1, white: node }
          : { number: rows.length + 1, black: node },
      );
    } else {
      last.black = node;
    }
  }

  const renderCell = (node: PositionNode | undefined) => {
    if (!node) return <span className="px-2 text-kca-gray-600">…</span>;

    const classification = classifications?.get(node.ply);
    const meta = classification ? CLASSIFICATION_META[classification] : null;
    const isActive = node.ply === currentPly;

    return (
      <button
        ref={isActive ? activeRef : undefined}
        type="button"
        onClick={() => onSelectPly(node.ply)}
        className={cn(
          "w-full text-left font-mono text-sm px-2 py-1 rounded transition-colors",
          isActive
            ? "bg-kca-cyan/15 text-kca-cyan font-bold"
            : "text-kca-gray-100 hover:bg-kca-surface-2",
        )}
      >
        {node.san}
        {meta?.symbol ? (
          <span className={cn("ml-1 font-bold", meta.textClass)} title={meta.label}>
            {meta.symbol}
          </span>
        ) : null}
      </button>
    );
  };

  return (
    <div className="card p-0 bg-kca-surface border border-kca-border overflow-hidden">
      <div className="px-4 py-2.5 border-b border-kca-border">
        <span className="text-[11px] uppercase tracking-wider text-kca-gray-400">Moves</span>
      </div>

      <div ref={scrollRef} className="max-h-[280px] overflow-y-auto">
        {nodes.length === 0 ? (
          <p className="px-4 py-6 text-sm text-kca-gray-400 text-center">
            No moves yet — play on the board or import a game.
          </p>
        ) : (
          <ul className="divide-y divide-kca-border/40">
            <li>
              <button
                type="button"
                onClick={() => onSelectPly(0)}
                className={cn(
                  "w-full text-left text-xs px-4 py-1.5 transition-colors",
                  currentPly === 0
                    ? "bg-kca-cyan/15 text-kca-cyan font-bold"
                    : "text-kca-gray-400 hover:bg-kca-surface-2",
                )}
              >
                Starting position
              </button>
            </li>
            {rows.map((row) => (
              <li key={row.number} className="grid grid-cols-[2.5rem_1fr_1fr] items-center px-2">
                <span className="text-xs font-mono text-kca-gray-600 pl-2">{row.number}.</span>
                {renderCell(row.white)}
                {renderCell(row.black)}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
