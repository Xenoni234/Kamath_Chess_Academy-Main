"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Chess } from "chess.js";
import { Bot, FlipVertical2, Flag, Lightbulb, Loader2, Undo2 } from "lucide-react";
import ChessBoard from "@/components/chess/ChessBoard";
import MoveList from "@/components/chess/MoveList";
import { useStockfish } from "@/hooks/useStockfish";
import { START_FEN } from "@/lib/engine/analysis";
import { uciToMove } from "@/lib/engine/uci";
import { cn } from "@/lib/utils";

/**
 * Play against Stockfish entirely in the browser.
 *
 * Unlike the live game room this never touches Socket.io and writes no Game
 * row: it is a practice tool, not a rated game, so the server-authoritative
 * rules for moves and clocks do not apply here.
 */

type Level = {
  id: number;
  name: string;
  /** Stockfish `Skill Level`, 0-20. */
  skill: number;
  /** `UCI_Elo` target, or null for full strength. */
  elo: number | null;
  movetimeMs: number;
};

const LEVELS: Level[] = [
  { id: 1, name: "Beginner", skill: 0, elo: 1320, movetimeMs: 200 },
  { id: 2, name: "Casual", skill: 3, elo: 1500, movetimeMs: 250 },
  { id: 3, name: "Club", skill: 6, elo: 1700, movetimeMs: 300 },
  { id: 4, name: "Improver", skill: 9, elo: 1900, movetimeMs: 400 },
  { id: 5, name: "Strong", skill: 12, elo: 2100, movetimeMs: 500 },
  { id: 6, name: "Expert", skill: 15, elo: 2300, movetimeMs: 700 },
  { id: 7, name: "Master", skill: 18, elo: 2600, movetimeMs: 1000 },
  { id: 8, name: "Full strength", skill: 20, elo: null, movetimeMs: 1500 },
];

const HINT_DEPTH = 12;
/** Minimum delay before the engine's reply lands, so it does not feel instant. */
const MIN_REPLY_MS = 350;

type Phase = "setup" | "playing" | "over";
type ColourChoice = "white" | "black" | "random";

export default function PlayEnginePage() {
  const chessRef = useRef(new Chess());
  const genRef = useRef(0);

  const [phase, setPhase] = useState<Phase>("setup");
  const [levelId, setLevelId] = useState(3);
  const [colourChoice, setColourChoice] = useState<ColourChoice>("white");
  const [playerColour, setPlayerColour] = useState<"w" | "b">("w");

  const [fen, setFen] = useState(START_FEN);
  const [moves, setMoves] = useState<string[]>([]);
  const [isEngineThinking, setIsEngineThinking] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);
  const [isFlipped, setIsFlipped] = useState(false);

  const level = useMemo(() => LEVELS.find((entry) => entry.id === levelId) ?? LEVELS[2], [levelId]);
  const engine = useStockfish({ multipv: 1, skillLevel: level.skill, elo: level.elo });
  const { isReady, analyze, newGame, stop, engineLabel } = engine;

  // Flipping is a view preference only — it never changes the colour you play.
  const playerIsWhite = playerColour === "w";
  const orientation: "white" | "black" = playerIsWhite === !isFlipped ? "white" : "black";
  const isPlayerTurn = phase === "playing" && chessRef.current.turn() === playerColour;

  const syncFromChess = useCallback(() => {
    const chess = chessRef.current;
    setFen(chess.fen());
    setMoves(
      chess.history({ verbose: true }).map((move) => `${move.from}${move.to}${move.promotion ?? ""}`),
    );
  }, []);

  const describeOutcome = useCallback((chess: Chess, colour: "w" | "b"): string | null => {
    if (chess.isCheckmate()) {
      return chess.turn() === colour ? "Checkmate — the engine wins." : "Checkmate — you win!";
    }
    if (chess.isStalemate()) return "Stalemate — a draw.";
    if (chess.isInsufficientMaterial()) return "Draw — insufficient material.";
    if (chess.isThreefoldRepetition()) return "Draw — threefold repetition.";
    if (chess.isDraw()) return "Draw — fifty-move rule.";
    return null;
  }, []);

  /** Ask the engine for a reply and play it, unless the game moved on meanwhile. */
  const playEngineMove = useCallback(
    async (colour: "w" | "b") => {
      const gen = genRef.current;
      setIsEngineThinking(true);

      try {
        const startedAt = Date.now();
        const result = await analyze({
          fen: chessRef.current.fen(),
          movetimeMs: level.movetimeMs,
          multipv: 1,
        });

        if (genRef.current !== gen) return;
        if (!result.bestMove || result.bestMove === "(none)") return;

        const elapsed = Date.now() - startedAt;
        if (elapsed < MIN_REPLY_MS) {
          await new Promise((resolve) => setTimeout(resolve, MIN_REPLY_MS - elapsed));
        }
        if (genRef.current !== gen) return;

        try {
          chessRef.current.move(uciToMove(result.bestMove));
        } catch {
          return;
        }

        syncFromChess();
        const ending = describeOutcome(chessRef.current, colour);
        if (ending) {
          setOutcome(ending);
          setPhase("over");
        }
      } finally {
        if (genRef.current === gen) setIsEngineThinking(false);
      }
    },
    [analyze, level.movetimeMs, syncFromChess, describeOutcome],
  );

  const startGame = useCallback(() => {
    genRef.current += 1;
    stop();
    newGame();

    const colour: "w" | "b" =
      colourChoice === "random" ? (Math.random() < 0.5 ? "w" : "b") : colourChoice === "white" ? "w" : "b";

    chessRef.current = new Chess();
    setPlayerColour(colour);
    setOutcome(null);
    setHint(null);
    setPhase("playing");
    syncFromChess();

    if (colour === "b") void playEngineMove(colour);
  }, [colourChoice, stop, newGame, syncFromChess, playEngineMove]);

  const handleMove = useCallback(
    (from: string, to: string, promotion?: string) => {
      if (phase !== "playing" || isEngineThinking) return;
      if (chessRef.current.turn() !== playerColour) return;

      try {
        const move = chessRef.current.move({ from, to, promotion: promotion ?? "q" });
        if (!move) return;
      } catch {
        return;
      }

      setHint(null);
      syncFromChess();

      const ending = describeOutcome(chessRef.current, playerColour);
      if (ending) {
        setOutcome(ending);
        setPhase("over");
        return;
      }

      void playEngineMove(playerColour);
    },
    [phase, isEngineThinking, playerColour, syncFromChess, describeOutcome, playEngineMove],
  );

  /** Take back the engine's reply and your own move. */
  const handleTakeback = useCallback(() => {
    if (phase === "setup" || isEngineThinking) return;

    genRef.current += 1;
    stop();

    const chess = chessRef.current;
    // Undo back to the player's turn — usually two half-moves, one if the
    // engine has not replied yet.
    chess.undo();
    if (chess.history().length > 0 && chess.turn() !== playerColour) chess.undo();

    setHint(null);
    setOutcome(null);
    setIsEngineThinking(false);
    setPhase("playing");
    syncFromChess();
  }, [phase, isEngineThinking, playerColour, stop, syncFromChess]);

  const handleHint = useCallback(async () => {
    if (!isPlayerTurn || isEngineThinking) return;
    const result = await analyze({ fen: chessRef.current.fen(), depth: HINT_DEPTH, multipv: 1 });
    if (result.bestMove) setHint(result.bestMove);
  }, [isPlayerTurn, isEngineThinking, analyze]);

  const handleResign = useCallback(() => {
    genRef.current += 1;
    stop();
    setIsEngineThinking(false);
    setOutcome("You resigned.");
    setPhase("over");
  }, [stop]);

  // Abandon any in-flight engine search when leaving the page.
  useEffect(() => {
    return () => {
      genRef.current += 1;
    };
  }, []);

  const arrows = useMemo(
    () =>
      hint
        ? [
            {
              startSquare: hint.slice(0, 2),
              endSquare: hint.slice(2, 4),
              color: "rgba(245, 158, 11, 0.7)",
            },
          ]
        : [],
    [hint],
  );

  const lastMoveUci = moves[moves.length - 1];
  const pgn = useMemo(() => (phase === "over" ? chessRef.current.pgn() : ""), [phase]);

  if (phase === "setup") {
    return (
      <div className="w-full max-w-2xl mx-auto">
        <div className="mb-8">
          <h1 className="text-3xl font-display font-bold text-kca-white mb-2">Play vs Engine</h1>
          <p className="text-sm text-kca-gray-400">
            Practise against {engineLabel}, running entirely in your browser. Games here are
            unrated and are not saved.
          </p>
        </div>

        <div className="card p-6 bg-kca-surface border border-kca-border flex flex-col gap-6">
          <div>
            <p className="text-[11px] uppercase tracking-wider text-kca-gray-400 mb-3">
              Play as
            </p>
            <div className="grid grid-cols-3 gap-2">
              {(["white", "black", "random"] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => setColourChoice(option)}
                  className={cn(
                    "py-2.5 rounded-lg text-sm capitalize border transition-colors",
                    colourChoice === option
                      ? "border-kca-cyan bg-kca-cyan/10 text-kca-cyan"
                      : "border-kca-border text-kca-gray-100 hover:border-kca-border-hover",
                  )}
                >
                  {option}
                </button>
              ))}
            </div>
          </div>

          <div>
            <div className="flex items-baseline justify-between mb-3">
              <p className="text-[11px] uppercase tracking-wider text-kca-gray-400">Difficulty</p>
              <p className="text-xs text-kca-gray-100">
                {level.name}
                {level.elo ? (
                  <span className="text-kca-gray-400 font-mono"> · ~{level.elo}</span>
                ) : null}
              </p>
            </div>
            <div className="grid grid-cols-4 sm:grid-cols-8 gap-1.5">
              {LEVELS.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  onClick={() => setLevelId(entry.id)}
                  title={entry.name}
                  className={cn(
                    "py-2 rounded-lg text-sm font-mono border transition-colors",
                    entry.id === levelId
                      ? "border-kca-cyan bg-kca-cyan/10 text-kca-cyan"
                      : "border-kca-border text-kca-gray-400 hover:border-kca-border-hover",
                  )}
                >
                  {entry.id}
                </button>
              ))}
            </div>
          </div>

          <button
            type="button"
            onClick={startGame}
            disabled={!isReady}
            className="btn-primary w-full py-3 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isReady ? (
              "Start game"
            ) : (
              <span className="flex items-center justify-center gap-2">
                <Loader2 className="w-4 h-4 animate-spin" />
                Loading engine…
              </span>
            )}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="w-full max-w-6xl mx-auto">
      <div className="mb-6 flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h1 className="text-3xl font-display font-bold text-kca-white mb-2">Play vs Engine</h1>
          <p className="text-sm text-kca-gray-400">
            Level {level.id} · {level.name}
            {level.elo ? <span className="font-mono"> (~{level.elo})</span> : null} · playing{" "}
            {playerColour === "w" ? "White" : "Black"}
          </p>
        </div>
        <button type="button" onClick={() => setPhase("setup")} className="btn-secondary py-2 px-4 text-sm">
          Change settings
        </button>
      </div>

      <div className="flex flex-col lg:flex-row gap-6 items-start">
        <div className="w-full max-w-[600px] mx-auto lg:mx-0">
          <div className="flex items-center justify-between gap-2 mb-2 px-1">
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-lg bg-kca-cyan/10 border border-kca-cyan/30 flex items-center justify-center">
                <Bot className="w-4 h-4 text-kca-cyan" />
              </div>
              <span className="text-sm text-kca-gray-100">Stockfish · level {level.id}</span>
            </div>
            {isEngineThinking && (
              <span className="flex items-center gap-1.5 text-xs text-kca-cyan">
                <Loader2 className="w-3 h-3 animate-spin" />
                Thinking
              </span>
            )}
          </div>

          {/* No eval bar here on purpose — showing the engine's evaluation of
              its own game would give the position away. */}
          <div className="aspect-square bg-kca-surface border border-kca-border rounded-2xl overflow-hidden p-1.5">
            <ChessBoard
              fen={fen}
              orientation={orientation}
              onMove={handleMove}
              disabled={!isPlayerTurn}
              lastMove={lastMoveUci}
              arrows={arrows}
            />
          </div>

          <div className="flex items-center justify-between gap-2 mt-3">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void handleHint()}
                disabled={!isPlayerTurn || isEngineThinking}
                className="btn-secondary py-2 px-3 text-xs flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <Lightbulb className="w-4 h-4" />
                Hint
              </button>
              <button
                type="button"
                onClick={handleTakeback}
                disabled={moves.length === 0 || isEngineThinking}
                className="btn-secondary py-2 px-3 text-xs flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <Undo2 className="w-4 h-4" />
                Takeback
              </button>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setIsFlipped((flipped) => !flipped)}
                aria-label="Flip board"
                className="btn-secondary p-2"
              >
                <FlipVertical2 className="w-4 h-4" />
              </button>
              <button
                type="button"
                onClick={handleResign}
                disabled={phase !== "playing"}
                className="btn-secondary py-2 px-3 text-xs flex items-center gap-1.5 text-kca-danger border-kca-danger/30 hover:bg-kca-danger/10 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <Flag className="w-4 h-4" />
                Resign
              </button>
            </div>
          </div>
        </div>

        <div className="w-full lg:w-[340px] flex flex-col gap-4">
          {outcome && (
            <div className="card p-5 bg-kca-surface border border-kca-cyan/40">
              <p className="text-lg font-display font-bold text-kca-white mb-1">Game over</p>
              <p className="text-sm text-kca-gray-100 mb-4">{outcome}</p>
              <div className="flex flex-col gap-2">
                <button type="button" onClick={startGame} className="btn-primary w-full py-2.5 text-sm">
                  Play again
                </button>
                {pgn && (
                  <Link
                    href={`/dashboard/analysis?pgn=${encodeURIComponent(pgn)}`}
                    className="btn-secondary w-full py-2.5 text-sm text-center"
                  >
                    Analyse this game
                  </Link>
                )}
              </div>
            </div>
          )}

          <div className="card p-4 bg-kca-surface border border-kca-border">
            <p className="text-[11px] uppercase tracking-wider text-kca-gray-400 mb-3">Move log</p>
            <MoveList moves={moves} />
          </div>
        </div>
      </div>
    </div>
  );
}
