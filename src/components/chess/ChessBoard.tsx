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

  /**
   * Tap-to-move: tap the piece, then tap the destination.
   *
   * Dragging was the only way to move, which is genuinely hard for the academy's youngest
   * students — they start at five — and hopeless on a phone or trackpad. Tapping is how
   * Lichess and Chess.com both work, and it is the accessible option besides: a drag needs
   * sustained fine motor control, a tap does not.
   *
   * Dragging still works exactly as before. These are two ways to make the same move, and
   * the drag handler and the tap handler go through the SAME `onMove`, so a consumer that
   * rejects a move (the puzzle page rejects a wrong guess) rejects it either way.
   */
  const [selected, setSelected] = useState<string | null>(null);
  /** Square to flash red for a moment, when a tap names an illegal destination. */
  const [rejected, setRejected] = useState<string | null>(null);

  // Parse FEN to check if king is in check
  const chess = new Chess(fen);

  // Drop any tap selection when the position changes — after the opponent moves, a square
  // held from the previous position points at a piece that may no longer be there.
  const [selectionFen, setSelectionFen] = useState(fen);
  if (fen !== selectionFen) {
    setSelectionFen(fen);
    setSelected(null);
    setRejected(null);
  }
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

  // Tap-to-move highlights. Drawn before the last-move highlight so an explicit
  // selection reads on top of the ambient one.
  if (selected) {
    customSquareStyles[selected] = {
      ...customSquareStyles[selected],
      backgroundColor: "rgba(0, 200, 232, 0.45)",
    };
    let targets: { to: string }[] = [];
    try {
      targets = chess.moves({ square: selected as Square, verbose: true });
    } catch {
      targets = [];
    }
    for (const move of targets) {
      // A ring rather than a fill, so the piece underneath a capture stays readable.
      customSquareStyles[move.to] = {
        ...customSquareStyles[move.to],
        boxShadow: "inset 0 0 0 4px rgba(0, 200, 232, 0.55)",
      };
    }
  }

  // An illegal tap gets the same red the in-check king gets — the student already knows
  // that colour means "not allowed", so it needs no explaining.
  if (rejected) {
    customSquareStyles[rejected] = {
      ...customSquareStyles[rejected],
      backgroundColor: "rgba(239, 68, 68, 0.55)",
    };
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

    setSelected(null);
    return onMove(sourceSquare, targetSquare) !== false;
  };

  /** Commit a move chosen by tapping, routing promotions through the same dialog. */
  const commitTap = (from: string, to: string) => {
    const piece = chess.get(from as Square);
    const isPromotion =
      piece?.type === "p" &&
      ((piece.color === "w" && to[1] === "8") || (piece.color === "b" && to[1] === "1"));

    if (isPromotion) {
      setPendingPromotion({ from, to });
      setSelected(null);
      return;
    }

    // A consumer may reject the move (the puzzle page rejects a wrong guess). When it
    // does, keep the piece selected so the student can simply tap somewhere else.
    if (onMove(from, to) === false) {
      flashRejected(to);
      return;
    }
    setSelected(null);
  };

  const flashRejected = (square: string) => {
    setRejected(square);
    window.setTimeout(() => setRejected((current) => (current === square ? null : current)), 600);
  };

  const handleSquareClick = ({ square }: { square: string }) => {
    if (disabled) return;

    if (selected === square) {
      setSelected(null);
      return;
    }

    if (selected) {
      let legal: { to: string }[] = [];
      try {
        legal = chess.moves({ square: selected as Square, verbose: true });
      } catch {
        legal = [];
      }

      if (legal.some((m) => m.to === square)) {
        commitTap(selected, square);
        return;
      }

      // Tapping another of your own pieces re-selects rather than erroring — that is
      // what a player means by it, and treating it as a mistake would be pedantic.
      const own = chess.get(square as Square);
      if (own && own.color === chess.turn()) {
        setSelected(square);
        return;
      }

      // A genuinely illegal destination: say so, briefly, in red.
      flashRejected(square);
      setSelected(null);
      return;
    }

    // Nothing selected yet — only a piece of the side to move can be picked up.
    const piece = chess.get(square as Square);
    if (piece && piece.color === chess.turn()) setSelected(square);
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
          onSquareClick: handleSquareClick,
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
