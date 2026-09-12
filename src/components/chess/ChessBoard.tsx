"use client";

import { useState } from "react";
import { Chess, Square } from "chess.js";
import { Chessboard } from "react-chessboard";

export type BoardArrow = {
  startSquare: string;
  endSquare: string;
  color: string;
};

type ChessBoardProps = {
  fen: string;
  orientation: "white" | "black";
  /**
   * Called when a legal move is dropped. Return `false` to REJECT it — the piece snaps
   * back and the board stays on `fen`.
   *
   * Returning nothing means "accepted", which is what every caller that drives `fen`
   * from the move itself wants. The puzzle page needs the other answer: a wrong guess is
   * legal chess but must not move the piece, and without a way to say so the board kept
   * the piece on the dropped square while `fen` still held the real position. That went
   * unnoticed while a wrong move locked the board; it stopped being invisible the moment
   * the board stayed live so students could try again.
   */
  onMove: (from: string, to: string, promotion?: string) => void | boolean;
  disabled?: boolean;
  lastMove?: string;
  /** Overlay arrows — the analysis board uses these for the engine's best move. */
  arrows?: BoardArrow[];
};

export default function ChessBoard({
  fen,
  orientation,
  onMove,
  disabled = false,
  lastMove,
  arrows,
}: ChessBoardProps) {
  const [pendingPromotion, setPendingPromotion] = useState<{
    from: string;
    to: string;
  } | null>(null);

  // Parse FEN to check if king is in check
  const chess = new Chess(fen);
  const customSquareStyles: Record<string, React.CSSProperties> = {};

  // Highlight King in check
  if (chess.inCheck()) {
    const turn = chess.turn();
    const board = chess.board();
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        const square = board[r][c];
        if (square && square.type === "k" && square.color === turn) {
          customSquareStyles[square.square] = {
            backgroundColor: "rgba(239, 68, 68, 0.4)",
          };
        }
      }
    }
  }

  // Highlight Last Move
  if (lastMove && lastMove.length >= 4) {
    const from = lastMove.substring(0, 2);
    const to = lastMove.substring(2, 4);
    customSquareStyles[from] = {
      ...customSquareStyles[from],
      backgroundColor: "rgba(0, 200, 232, 0.3)",
    };
    customSquareStyles[to] = {
      ...customSquareStyles[to],
      backgroundColor: "rgba(0, 200, 232, 0.3)",
    };
  }

  // Intercept pawn drops for promotion
  const handlePieceDrop = ({
    piece,
    sourceSquare,
    targetSquare,
  }: {
    piece: { pieceType: string };
    sourceSquare: string;
    targetSquare: string | null;
  }) => {
    if (disabled || !targetSquare) return false;

    const game = new Chess(fen);
    const pieceColor = piece.pieceType[0];
    const pieceType = piece.pieceType[1].toLowerCase();

    // Only accept the drop if it is a legal move from this square. Illegal
    // drops snap back cleanly instead of throwing inside chess.js (which would
    // surface as a dev-overlay console error).
    let legalMoves;
    try {
      legalMoves = game.moves({ square: sourceSquare as Square, verbose: true });
    } catch {
      return false;
    }
    if (!legalMoves.some((m) => m.to === targetSquare)) {
      return false;
    }

    const isPawn = pieceType === "p";
    const isPromotionRank =
      (pieceColor === "w" && targetSquare[1] === "8") ||
      (pieceColor === "b" && targetSquare[1] === "1");

    if (isPawn && isPromotionRank) {
      setPendingPromotion({ from: sourceSquare, to: targetSquare });
      return false; // wait for promotion-piece selection before committing
    }

    return onMove(sourceSquare, targetSquare) !== false;
  };

  const handlePromote = (pieceType: "q" | "r" | "b" | "n") => {
    if (pendingPromotion) {
      onMove(pendingPromotion.from, pendingPromotion.to, pieceType);
      setPendingPromotion(null);
    }
  };

  return (
    <div className="relative w-full h-full">
      <Chessboard
        options={{
          position: fen,
          boardOrientation: orientation,
          onPieceDrop: handlePieceDrop,
          allowDragging: !disabled,
          darkSquareStyle: { backgroundColor: "#769656" },
          lightSquareStyle: { backgroundColor: "#EEEED2" },
          squareStyles: customSquareStyles,
          arrows: arrows ?? [],
        }}
      />

      {/* Promotion Dialog Modal in KCA Dark/Cyan Style */}
      {pendingPromotion && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-kca-black/85 backdrop-blur-sm transition-all duration-300">
          <div className="card w-80 text-center flex flex-col gap-4 max-w-[90%] border border-kca-cyan shadow-cyan-md bg-kca-surface p-6">
            <div>
              <h4 className="text-lg font-bold text-kca-white uppercase tracking-wider">
                Pawn Promotion
              </h4>
              <p className="text-xs text-kca-gray-400 mt-1">
                Select piece to promote your pawn
              </p>
            </div>
            
            <div className="grid grid-cols-2 gap-3">
              <button
                onClick={() => handlePromote("q")}
                className="btn-secondary py-3 text-sm flex flex-col items-center justify-center gap-1 group hover:border-kca-cyan hover:bg-kca-cyan/10"
              >
                <span className="text-2xl group-hover:scale-110 transition-transform">♛</span>
                <span>Queen</span>
              </button>
              <button
                onClick={() => handlePromote("r")}
                className="btn-secondary py-3 text-sm flex flex-col items-center justify-center gap-1 group hover:border-kca-cyan hover:bg-kca-cyan/10"
              >
                <span className="text-2xl group-hover:scale-110 transition-transform">♜</span>
                <span>Rook</span>
              </button>
              <button
                onClick={() => handlePromote("b")}
                className="btn-secondary py-3 text-sm flex flex-col items-center justify-center gap-1 group hover:border-kca-cyan hover:bg-kca-cyan/10"
              >
                <span className="text-2xl group-hover:scale-110 transition-transform">♝</span>
                <span>Bishop</span>
              </button>
              <button
                onClick={() => handlePromote("n")}
                className="btn-secondary py-3 text-sm flex flex-col items-center justify-center gap-1 group hover:border-kca-cyan hover:bg-kca-cyan/10"
              >
                <span className="text-2xl group-hover:scale-110 transition-transform">♞</span>
                <span>Knight</span>
              </button>
            </div>
            
            <button
              onClick={() => setPendingPromotion(null)}
              className="text-xs text-kca-gray-400 hover:text-kca-white transition-colors mt-2"
            >
              Cancel Move
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
