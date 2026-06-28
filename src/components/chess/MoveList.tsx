"use client";

import { useEffect, useRef } from "react";
import { Chess } from "chess.js";

type MoveListProps = {
  moves: string[];
};

type MovePair = {
  number: number;
  white: string;
  black: string;
};

export default function MoveList({ moves = [] }: MoveListProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  // Parse moves into move pairs
  const parseMoves = (uciMoves: string[]): MovePair[] => {
    if (!uciMoves || uciMoves.length === 0) return [];

    const chess = new Chess();
    const sanMoves = uciMoves.map((uci) => {
      try {
        const move = chess.move({
          from: uci.slice(0, 2),
          to: uci.slice(2, 4),
          promotion: uci[4] || undefined,
        });
        return move?.san || uci;
      } catch (e) {
        console.error("Error parsing move:", uci, e);
        return uci;
      }
    });

    const movePairs: MovePair[] = [];
    for (let i = 0; i < sanMoves.length; i += 2) {
      movePairs.push({
        number: Math.floor(i / 2) + 1,
        white: sanMoves[i],
        black: sanMoves[i + 1] || "",
      });
    }
    return movePairs;
  };

  const movesList = parseMoves(moves);
  const totalMovesCount = movesList.length;
  const lastIndex = totalMovesCount - 1;
  const isWhiteLast = totalMovesCount > 0 && !movesList[lastIndex].black;

  // Auto-scroll to the latest move
  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [moves]);

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
