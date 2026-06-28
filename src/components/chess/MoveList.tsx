"use client";

import { useEffect, useRef } from "react";

type MoveListProps = {
  pgn: string;
};

type MovePair = {
  number: number;
  white: string;
  black: string;
};

export default function MoveList({ pgn }: MoveListProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  // Parse PGN into move pairs
  const parsePgn = (pgnString: string): MovePair[] => {
    if (!pgnString) return [];

    // Strip comments, annotations, and clean up spaces
    const cleanPgn = pgnString.replace(/\{.*?\}/g, "").replace(/\s+/g, " ").trim();
    const parts = cleanPgn.split(" ").filter(Boolean);

    const moves: MovePair[] = [];
    let currentPair: MovePair | null = null;

    for (const part of parts) {
      if (part.includes(".")) {
        // e.g. "1." or "1.e4"
        const num = parseInt(part);
        const rest = part.split(".").pop() || "";
        currentPair = { number: num, white: rest, black: "" };
        moves.push(currentPair);
      } else {
        if (currentPair) {
          if (!currentPair.white) {
            currentPair.white = part;
          } else if (!currentPair.black) {
            currentPair.black = part;
          }
        } else {
          // Fallback if no move number preceded (should not happen with standard chess.js PGN)
          currentPair = { number: moves.length + 1, white: part, black: "" };
          moves.push(currentPair);
        }
      }
    }
    return moves;
  };

  const movesList = parsePgn(pgn);
  const totalMovesCount = movesList.length;
  const lastIndex = totalMovesCount - 1;
  const isWhiteLast = totalMovesCount > 0 && !movesList[lastIndex].black;

  // Auto-scroll to the latest move
  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [pgn]);

  return (
    <div
      ref={containerRef}
      className="h-full w-full overflow-y-auto pr-1 select-none font-mono text-sm"
      style={{ maxHeight: "360px" }}
    >
      {movesList.length === 0 ? (
        <div className="text-kca-gray-600 text-center py-8 italic">
          No moves played yet.
        </div>
      ) : (
        <div className="grid grid-cols-12 gap-y-1">
          {movesList.map((move, idx) => {
            const isWhiteActive = idx === lastIndex && isWhiteLast;
            const isBlackActive = idx === lastIndex && !isWhiteLast;

            return (
              <div key={move.number} className="col-span-12 grid grid-cols-12 items-center py-1 hover:bg-kca-surface-2 rounded px-2 transition-colors">
                {/* Move Number */}
                <div className="col-span-2 text-kca-gray-600 font-semibold">
                  {move.number}.
                </div>

                {/* White Move */}
                <div className="col-span-5 pr-2">
                  {move.white && (
                    <span
                      className={encodeURI(
                        `px-2 py-0.5 rounded transition-all font-semibold ${
                          isWhiteActive
                            ? "bg-kca-cyan text-kca-black shadow-[0_0_10px_rgba(0,200,232,0.3)]"
                            : "text-kca-white"
                        }`
                      )}
                    >
                      {move.white}
                    </span>
                  )}
                </div>

                {/* Black Move */}
                <div className="col-span-5">
                  {move.black && (
                    <span
                      className={encodeURI(
                        `px-2 py-0.5 rounded transition-all font-semibold ${
                          isBlackActive
                            ? "bg-kca-cyan text-kca-black shadow-[0_0_10px_rgba(0,200,232,0.3)]"
                            : "text-kca-white"
                        }`
                      )}
                    >
                      {move.black}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
