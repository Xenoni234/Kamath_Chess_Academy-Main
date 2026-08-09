"use client";

import { useState } from "react";
import { ClipboardPaste, RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";

type ImportPanelProps = {
  onLoadPgn: (pgn: string) => string | null;
  onLoadFen: (fen: string) => string | null;
  onReset: () => void;
};

type Tab = "pgn" | "fen";

export default function ImportPanel({ onLoadPgn, onLoadFen, onReset }: ImportPanelProps) {
  const [tab, setTab] = useState<Tab>("pgn");
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);

  const handleLoad = () => {
    const trimmed = value.trim();
    if (!trimmed) {
      setError(tab === "pgn" ? "Paste a PGN first." : "Paste a FEN first.");
      return;
    }

    // The handlers return an error message, or null on success.
    const message = tab === "pgn" ? onLoadPgn(trimmed) : onLoadFen(trimmed);
    setError(message);
    if (!message) setValue("");
  };

  return (
    <div className="card p-4 bg-kca-surface border border-kca-border">
      <div className="flex items-center justify-between gap-2 mb-3">
        <div className="flex items-center gap-2">
          <ClipboardPaste className="w-4 h-4 text-kca-cyan" />
          <span className="text-[11px] uppercase tracking-wider text-kca-gray-400">Import</span>
        </div>
        <button
          type="button"
          onClick={() => {
            setValue("");
            setError(null);
            onReset();
          }}
          className="flex items-center gap-1 text-[11px] text-kca-gray-400 hover:text-kca-white transition-colors"
        >
          <RotateCcw className="w-3 h-3" />
          New board
        </button>
      </div>

      <div className="flex gap-1 mb-2">
        {(["pgn", "fen"] as const).map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => {
              setTab(option);
              setError(null);
            }}
            className={cn(
              "px-3 py-1 rounded-lg text-[11px] uppercase tracking-wider transition-colors",
              tab === option
                ? "bg-kca-cyan/15 text-kca-cyan"
                : "text-kca-gray-400 hover:text-kca-white",
            )}
          >
            {option}
          </button>
        ))}
      </div>

      <textarea
        value={value}
        onChange={(event) => setValue(event.target.value)}
        rows={tab === "pgn" ? 4 : 2}
        placeholder={
          tab === "pgn"
            ? "1. e4 e5 2. Nf3 Nc6 …  (paste a PGN from Lichess or Chess.com)"
            : "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"
        }
        className="input-field w-full font-mono text-xs resize-none"
      />

      {error && <p className="mt-2 text-xs text-kca-danger">{error}</p>}

      <button type="button" onClick={handleLoad} className="btn-primary w-full mt-3 py-2 text-sm">
        Load {tab.toUpperCase()}
      </button>
    </div>
  );
}
