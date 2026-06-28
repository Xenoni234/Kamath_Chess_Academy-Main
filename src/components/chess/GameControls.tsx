"use client";

import { useState, useEffect, useRef } from "react";

type GameControlsProps = {
  onResign: () => void;
  onDrawOffer: () => void;
  onAbort: () => void;
  canAbort: boolean;
  drawOffered: boolean;
  isMyTurn: boolean;
};

export default function GameControls({
  onResign,
  onDrawOffer,
  onAbort,
  canAbort,
  drawOffered,
  isMyTurn,
}: GameControlsProps) {
  const [confirmAction, setConfirmAction] = useState<"abort" | "draw" | "resign" | null>(null);
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  const handleActionClick = (action: "abort" | "draw" | "resign", callback: () => void) => {
    if (confirmAction === action) {
      // Second click: Execute the action
      callback();
      setConfirmAction(null);
      if (timerRef.current) clearTimeout(timerRef.current);
    } else {
      // First click: Enter confirmation state
      setConfirmAction(action);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        setConfirmAction(null);
      }, 3000);
    }
  };

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  return (
    <div className="flex flex-wrap gap-3 items-center justify-stretch w-full">
      {/* Abort button: Only visible if canAbort is true */}
      {canAbort && (
        <button
          onClick={() => handleActionClick("abort", onAbort)}
          className={`btn-secondary flex-1 text-sm font-bold min-h-12 border ${
            confirmAction === "abort"
              ? "bg-kca-danger/20 border-kca-danger text-kca-danger hover:bg-kca-danger/30"
              : "hover:bg-kca-cyan/10"
          }`}
        >
          {confirmAction === "abort" ? "Confirm Abort?" : "Abort"}
        </button>
      )}

      {/* Draw button: Disabled if not user's turn or already offered */}
      <button
        onClick={() => handleActionClick("draw", onDrawOffer)}
        disabled={!isMyTurn || drawOffered}
        className={`btn-secondary flex-1 text-sm font-bold min-h-12 border ${
          confirmAction === "draw"
            ? "bg-kca-warning/20 border-kca-warning text-kca-warning hover:bg-kca-warning/30"
            : "hover:bg-kca-cyan/10"
        } disabled:opacity-40 disabled:cursor-not-allowed`}
      >
        {confirmAction === "draw" ? "Confirm Draw?" : drawOffered ? "Draw Offered" : "Offer Draw"}
      </button>

      {/* Resign button: Always visible */}
      <button
        onClick={() => handleActionClick("resign", onResign)}
        className={`btn-secondary flex-1 text-sm font-bold min-h-12 border ${
          confirmAction === "resign"
            ? "bg-kca-danger/20 border-kca-danger text-kca-danger hover:bg-kca-danger/30"
            : "hover:bg-kca-cyan/10"
        }`}
      >
        {confirmAction === "resign" ? "Confirm Resign?" : "Resign"}
      </button>
    </div>
  );
}
