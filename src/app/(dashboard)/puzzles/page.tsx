"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Chess } from "chess.js";
import { CheckCircle2, XCircle, Loader2, ArrowRight, Puzzle as PuzzleIcon, Target, Flame, Award, Trophy } from "lucide-react";
import { cn } from "@/lib/utils";
import ChessBoard from "@/components/chess/ChessBoard";

type PuzzleData = {
  id: string;
  fen: string;
  moves: string;
  rating: number | null;
  themes: string[];
  source?: string;
};

type Status = "loading" | "solving" | "solved" | "failed" | "error";

const DIFFICULTIES = [
  { label: "All levels", min: 800, max: 2800 },
  { label: "Beginner", min: 800, max: 1200 },
  { label: "Intermediate", min: 1200, max: 1600 },
  { label: "Advanced", min: 1600, max: 2000 },
  { label: "Expert", min: 2000, max: 2800 },
];

// Curated from the imported Lichess themes (value = Lichess theme key).
const THEMES: { value: string; label: string }[] = [
  { value: "", label: "All themes" },
  { value: "mate", label: "Checkmate" },
  { value: "mateIn1", label: "Mate in 1" },
  { value: "mateIn2", label: "Mate in 2" },
  { value: "mateIn3", label: "Mate in 3" },
  { value: "backRankMate", label: "Back-rank mate" },
  { value: "fork", label: "Fork" },
  { value: "pin", label: "Pin" },
  { value: "skewer", label: "Skewer" },
  { value: "discoveredAttack", label: "Discovered attack" },
  { value: "sacrifice", label: "Sacrifice" },
  { value: "deflection", label: "Deflection" },
  { value: "attraction", label: "Attraction" },
  { value: "hangingPiece", label: "Hanging piece" },
  { value: "trappedPiece", label: "Trapped piece" },
  { value: "intermezzo", label: "Zwischenzug" },
  { value: "promotion", label: "Promotion" },
  { value: "advancedPawn", label: "Advanced pawn" },
  { value: "zugzwang", label: "Zugzwang" },
  { value: "endgame", label: "Endgame (any)" },
  { value: "rookEndgame", label: "Rook endgame" },
  { value: "pawnEndgame", label: "Pawn endgame" },
  { value: "queenEndgame", label: "Queen endgame" },
  { value: "bishopEndgame", label: "Bishop endgame" },
  { value: "knightEndgame", label: "Knight endgame" },
  { value: "opening", label: "Opening" },
  { value: "middlegame", label: "Middlegame" },
];

function uciToMove(uci: string) {
  return {
    from: uci.slice(0, 2),
    to: uci.slice(2, 4),
    promotion: uci.length > 4 ? uci[4].toLowerCase() : undefined,
  };
}

export default function PuzzlesPage() {
  const chessRef = useRef(new Chess());
  const solutionRef = useRef<string[]>([]);
  const idxRef = useRef(0); // index of the next expected move in the solution
  const startRef = useRef<number>(Date.now());
  const submittedRef = useRef(false);
  const puzzleRef = useRef<PuzzleData | null>(null);
  const statusRef = useRef<Status>("loading");
  // Bumped on every load so pending setTimeouts from a previous puzzle can
  // detect they are stale and bail out instead of moving on the new board.
  const genRef = useRef(0);

  const [puzzle, setPuzzle] = useState<PuzzleData | null>(null);
  const [fen, setFen] = useState(chessRef.current.fen());
  const [orientation, setOrientation] = useState<"white" | "black">("white");
  const [status, setStatusState] = useState<Status>("loading");
  const [lastMove, setLastMove] = useState<string | undefined>();
  const [boardLocked, setBoardLocked] = useState(true);
  const [wrongFlash, setWrongFlash] = useState(false);
  const [bestMove, setBestMove] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState("");
  const [difficultyIdx, setDifficultyIdx] = useState(0);
  const [theme, setTheme] = useState("");
  const [streak, setStreak] = useState(0);
  const [bestStreak, setBestStreak] = useState(0);
  const [solvedCount, setSolvedCount] = useState<number | null>(null);

  const setStatus = (s: Status) => {
    statusRef.current = s;
    setStatusState(s);
  };

  const submitAttempt = useCallback(async (solved: boolean) => {
    const current = puzzleRef.current;
    if (submittedRef.current || !current) return;
    submittedRef.current = true;

    // Update streak stats immediately (server call below is just persistence).
    if (solved) {
      setStreak((s) => s + 1);
      setSolvedCount((c) => (c === null ? 1 : c + 1));
    } else {
      setStreak(0);
    }

    const timeTakenMs = Math.max(1, Date.now() - startRef.current);
    try {
      await fetch(`/api/puzzles/${current.id}/attempt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ solved, timeTakenMs }),
      });
    } catch {
      // Non-blocking: scheduling failure shouldn't break the solving flow.
    }
  }, []);

  const loadPuzzle = useCallback(async () => {
    const gen = ++genRef.current;
    setStatus("loading");
    setErrorMsg("");
    setBestMove(null);
    setLastMove(undefined);
    setBoardLocked(true);
    submittedRef.current = false;

    try {
      const band = DIFFICULTIES[difficultyIdx];
      const params = new URLSearchParams({ minRating: String(band.min), maxRating: String(band.max), limit: "1" });
      if (theme) params.set("theme", theme);
      const res = await fetch(`/api/puzzles?${params.toString()}`);
      const data = await res.json();
      if (!res.ok || !data.success || !data.puzzles?.length) {
        setErrorMsg(data.message ?? "No puzzles available.");
        setStatus("error");
        return;
      }

      const p: PuzzleData = data.puzzles[0];
      const solution = p.moves.trim().split(/\s+/).filter(Boolean);
      if (solution.length < 2) {
        // Not a solvable puzzle line; skip to the next.
        return loadPuzzle();
      }

      const chess = new Chess(p.fen);
      chessRef.current = chess;
      solutionRef.current = solution;
      idxRef.current = 0;
      puzzleRef.current = p;

      // The player is the side to move AFTER the opponent's setup move.
      const preview = new Chess(p.fen);
      preview.move(uciToMove(solution[0]));

      setPuzzle(p);
      setOrientation(preview.turn() === "w" ? "white" : "black");
      setFen(chess.fen());
      setStatus("solving");

      // Auto-play the opponent's setup move after a beat, then hand control over.
      window.setTimeout(() => {
        if (genRef.current !== gen) return; // a newer puzzle loaded; bail
        try {
          chessRef.current.move(uciToMove(solution[0]));
        } catch {
          return;
        }
        setFen(chessRef.current.fen());
        setLastMove(solution[0].slice(0, 4));
        idxRef.current = 1;
        startRef.current = Date.now();
        setBoardLocked(false);
      }, 550);
    } catch {
      setErrorMsg("Failed to load puzzle.");
      setStatus("error");
    }
  }, [difficultyIdx, theme]);

  useEffect(() => {
    void loadPuzzle();
  }, [loadPuzzle]);

  // Track the best streak reached this session.
  useEffect(() => {
    setBestStreak((b) => Math.max(b, streak));
  }, [streak]);

  // Load the user's all-time solved count once.
  useEffect(() => {
    fetch("/api/puzzles/stats")
      .then((r) => r.json())
      .then((d) => {
        if (d?.success) setSolvedCount(d.solved);
      })
      .catch(() => {});
  }, []);

  const handleMove = (from: string, to: string, promotion?: string) => {
    if (statusRef.current !== "solving" || boardLocked) return;

    const expected = solutionRef.current[idxRef.current];
    const exp = uciToMove(expected);
    const correct = exp.from === from && exp.to === to && (exp.promotion ?? "") === (promotion?.toLowerCase() ?? "");

    if (!correct) {
      setWrongFlash(true);
      window.setTimeout(() => setWrongFlash(false), 500);
      setBestMove(expected);
      setStatus("failed");
      void submitAttempt(false);
      return;
    }

    // Correct player move — apply it.
    try {
      chessRef.current.move({ from, to, promotion });
    } catch {
      return;
    }
    setFen(chessRef.current.fen());
    setLastMove(`${from}${to}`);
    idxRef.current += 1;

    if (idxRef.current >= solutionRef.current.length) {
      setStatus("solved");
      void submitAttempt(true);
      return;
    }

    // Opponent's scripted reply.
    setBoardLocked(true);
    const reply = solutionRef.current[idxRef.current];
    const gen = genRef.current;
    window.setTimeout(() => {
      if (genRef.current !== gen) return; // a newer puzzle loaded; bail
      try {
        chessRef.current.move(uciToMove(reply));
      } catch {
        return;
      }
      setFen(chessRef.current.fen());
      setLastMove(reply.slice(0, 4));
      idxRef.current += 1;
      if (idxRef.current >= solutionRef.current.length) {
        setStatus("solved");
        void submitAttempt(true);
      } else {
        setBoardLocked(false);
      }
    }, 400);
  };

  const disabled = boardLocked || (status !== "solving");

  return (
    <div className="w-full max-w-6xl mx-auto">
      <div className="mb-6 flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div>
          <h1 className="text-3xl font-display font-bold text-kca-white mb-2">Puzzles</h1>
          <p className="text-sm text-kca-gray-400">Solve tactics. Correct solves are scheduled for spaced-repetition review.</p>
        </div>
        <div className="flex flex-wrap gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-kca-gray-400">Difficulty</span>
            <select
              value={difficultyIdx}
              onChange={(e) => setDifficultyIdx(Number(e.target.value))}
              className="bg-kca-surface border border-kca-border rounded-lg px-3 py-2 text-sm text-kca-white focus:outline-none focus:border-kca-cyan cursor-pointer min-w-[150px]"
            >
              {DIFFICULTIES.map((d, i) => (
                <option key={d.label} value={i}>{d.label} {d.min}–{d.max}</option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-kca-gray-400">Theme</span>
            <select
              value={theme}
              onChange={(e) => setTheme(e.target.value)}
              className="bg-kca-surface border border-kca-border rounded-lg px-3 py-2 text-sm text-kca-white focus:outline-none focus:border-kca-cyan cursor-pointer min-w-[170px]"
            >
              {THEMES.map((t) => (
                <option key={t.value || "all"} value={t.value}>{t.label}</option>
              ))}
            </select>
          </label>
        </div>
      </div>

      <div className="flex flex-col lg:flex-row gap-6 items-start">
        {/* Board */}
        <div className="w-full max-w-[560px] mx-auto lg:mx-0">
          <div
            className={cn(
              "aspect-square w-full bg-kca-surface border border-kca-border rounded-2xl overflow-hidden p-1.5 transition-all duration-300",
              wrongFlash && "ring-4 ring-kca-danger border-kca-danger",
              status === "solved" && "ring-2 ring-kca-success"
            )}
          >
            {status === "loading" ? (
              <div className="w-full h-full flex items-center justify-center text-kca-gray-400">
                <Loader2 className="w-8 h-8 animate-spin text-kca-cyan" />
              </div>
            ) : (
              <ChessBoard fen={fen} orientation={orientation} onMove={handleMove} disabled={disabled} lastMove={lastMove} />
            )}
          </div>
        </div>

        {/* Side panel */}
        <div className="w-full lg:w-[340px] flex flex-col gap-4">
          {/* Streak / stats */}
          <div className="grid grid-cols-3 gap-3">
            <div className={cn(
              "card p-4 flex flex-col items-center justify-center gap-1 bg-kca-surface border",
              streak > 0 ? "border-kca-warning/40" : "border-kca-border"
            )}>
              <Flame className={cn("w-5 h-5", streak > 0 ? "text-kca-warning" : "text-kca-gray-400")} />
              <span className="text-2xl font-bold font-mono text-kca-white leading-none">{streak}</span>
              <span className="text-[10px] uppercase tracking-wider text-kca-gray-400">Streak</span>
            </div>
            <div className="card p-4 flex flex-col items-center justify-center gap-1 bg-kca-surface border border-kca-border">
              <Award className="w-5 h-5 text-kca-cyan" />
              <span className="text-2xl font-bold font-mono text-kca-white leading-none">{bestStreak}</span>
              <span className="text-[10px] uppercase tracking-wider text-kca-gray-400">Best</span>
            </div>
            <div className="card p-4 flex flex-col items-center justify-center gap-1 bg-kca-surface border border-kca-border">
              <Trophy className="w-5 h-5 text-kca-success" />
              <span className="text-2xl font-bold font-mono text-kca-white leading-none">{solvedCount ?? "—"}</span>
              <span className="text-[10px] uppercase tracking-wider text-kca-gray-400">Solved</span>
            </div>
          </div>

          {/* Puzzle meta */}
          <div className="card p-5 bg-kca-surface border border-kca-border">
            <div className="flex items-center gap-3 mb-4">
              <div className="h-10 w-10 rounded-lg bg-kca-cyan/10 border border-kca-cyan/30 flex items-center justify-center">
                <PuzzleIcon className="w-5 h-5 text-kca-cyan" />
              </div>
              <div>
                <div className="text-sm font-semibold text-kca-white">Tactic Trainer</div>
                <div className="text-xs text-kca-gray-400">
                  {puzzle?.rating ? `Rating ${puzzle.rating}` : "Live puzzle"}
                </div>
              </div>
            </div>
            {puzzle?.themes && puzzle.themes.length > 0 && status !== "solving" && (
              <div className="flex flex-wrap gap-1.5">
                {puzzle.themes.slice(0, 6).map((t) => (
                  <span key={t} className="text-[10px] uppercase tracking-wider font-semibold px-2 py-1 rounded-md bg-kca-surface-2 border border-kca-border text-kca-gray-100">
                    {t}
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* Status / prompt */}
          <div className="card p-5 bg-kca-surface border border-kca-border min-h-[120px] flex flex-col justify-center">
            {status === "solving" && (
              <div className="flex items-center gap-3 text-kca-white">
                <Target className="w-5 h-5 text-kca-cyan shrink-0" />
                <div>
                  <div className="font-semibold">{orientation === "white" ? "White" : "Black"} to move</div>
                  <div className="text-xs text-kca-gray-400 mt-0.5">Find the best move.</div>
                </div>
              </div>
            )}
            {status === "solved" && (
              <div className="flex items-center gap-3 text-kca-success">
                <CheckCircle2 className="w-6 h-6 shrink-0" />
                <div>
                  <div className="font-bold text-lg">Solved!</div>
                  <div className="text-xs text-kca-gray-400 mt-0.5">Scheduled for spaced review.</div>
                </div>
              </div>
            )}
            {status === "failed" && (
              <div className="flex items-center gap-3 text-kca-danger">
                <XCircle className="w-6 h-6 shrink-0" />
                <div>
                  <div className="font-bold text-lg">Incorrect</div>
                  <div className="text-xs text-kca-gray-400 mt-0.5">
                    Best move was <span className="font-mono text-kca-white">{bestMove}</span>. You&apos;ll see this one again sooner.
                  </div>
                </div>
              </div>
            )}
            {status === "loading" && <div className="text-sm text-kca-gray-400">Loading puzzle…</div>}
            {status === "error" && <div className="text-sm text-kca-danger">{errorMsg}</div>}
          </div>

          {/* Controls */}
          <button
            onClick={() => void loadPuzzle()}
            disabled={status === "loading"}
            className="btn-primary w-full py-3 font-bold disabled:opacity-50"
          >
            {status === "solving" ? "Skip Puzzle" : "Next Puzzle"}
            <ArrowRight className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
