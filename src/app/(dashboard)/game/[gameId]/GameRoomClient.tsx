"use client";

import { useEffect, useState, useRef } from "react";
import Link from "next/link";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { Chess } from "chess.js";
import { getSocket } from "@/lib/socket/client";
import { cn } from "@/lib/utils";
import ChessBoard from "@/components/chess/ChessBoard";
import GameClock from "@/components/chess/GameClock";
import MoveList from "@/components/chess/MoveList";
import GameControls from "@/components/chess/GameControls";
import { type GameState } from "@/lib/socket/gameEngine";

type PlayerInfo = {
  username: string;
  rating: number;
};

type GameRoomClientProps = {
  gameId: string;
  userId: string;
  username: string;
  role: string;
  activeGame: GameState | null; // Initially loaded active game state (or null)
  dbGame: GameState | null; // Initially loaded finished game state (or null)
  isFinished: boolean;
  initialPlayers: {
    white: PlayerInfo;
    black: PlayerInfo;
  };
};

export default function GameRoomClient({
  gameId,
  userId,
  username,
  role,
  activeGame: initialActiveGame,
  dbGame: initialDbGame,
  isFinished: initialIsFinished,
  initialPlayers,
}: GameRoomClientProps) {
  const router = useRouter();
  const dashboardHref = `/dashboard/${role.toLowerCase()}`;

  // Game state
  const [game, setGame] = useState<GameState>(initialActiveGame || initialDbGame!);
  const [fen, setFen] = useState<string>(game.fen);
  const [lastValidFen, setLastValidFen] = useState<string>(game.fen);
  const [pgn, setPgn] = useState<string>(game.pgn || "");
  const [status, setStatus] = useState<string>(game.status);
  const [result, setResult] = useState<string | undefined>(game.result);
  const [terminatedBy, setTerminatedBy] = useState<string | undefined>(game.terminatedBy || game.termination);
  const [whiteTime, setWhiteTime] = useState<number>(game.whiteTimeMs ?? 0);
  const [blackTime, setBlackTime] = useState<number>(game.blackTimeMs ?? 0);

  // UI state
  const [flashRed, setFlashRed] = useState(false);
  const [drawOffer, setDrawOffer] = useState<{ gameId: string; offeredBy: string } | null>(null);
  const [ratingChange, setRatingChange] = useState<number | null>(null);
  const [fetchingRating, setFetchingRating] = useState(false);

  const isPlayer = userId === game.white || userId === game.black;
  const isSpectator = !isPlayer;
  const orientation = userId === game.black ? "black" : "white";

  // Last move for highlight
  const lastMove = game.moves && game.moves.length > 0 ? game.moves[game.moves.length - 1] : undefined;

  const opponentName = userId === game.white ? initialPlayers.black.username : initialPlayers.white.username;
  const opponentRating = userId === game.white ? initialPlayers.black.rating : initialPlayers.white.rating;
  const userName = userId === game.white ? initialPlayers.white.username : initialPlayers.black.username;
  const userRating = userId === game.white ? initialPlayers.white.rating : initialPlayers.black.rating;

  // Active status of clocks
  const isOngoing = status === "ongoing";
  const whiteClockActive = isOngoing && game.turn === "w";
  const blackClockActive = isOngoing && game.turn === "b";

  // Check if abort is allowed (fewer than 2 full moves)
  const canAbort = isPlayer && isOngoing && (!game.moves || game.moves.length < 4);

  // Set up stylesheet body class override to hide sidebar
  useEffect(() => {
    document.body.classList.add("game-page-active");
    return () => {
      document.body.classList.remove("game-page-active");
    };
  }, []);

  // Fetch rating change when game ends (with retries)
  const fetchRatingChange = async () => {
    if (fetchingRating) return;
    setFetchingRating(true);

    const maxRetries = 5;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        // Increasing delay to let DB write complete
        await new Promise((resolve) => setTimeout(resolve, 800 + attempt * 600));
        const res = await fetch(`/api/games/${gameId}`);
        const data = await res.json();
        const record = data.game.records?.find((r: { userId: string; ratingBefore: number; ratingAfter: number }) => r.userId === userId);
        if (record && record.ratingAfter !== null && record.ratingBefore !== null) {
          setRatingChange(record.ratingAfter - record.ratingBefore);
          setFetchingRating(false);
          return;
        }
      } catch (e) {
        console.error(`Error fetching rating change (attempt ${attempt + 1}):`, e);
      }
    }

    // All retries exhausted — show 0 change rather than stuck on "Calculating..."
    setRatingChange(0);
    setFetchingRating(false);
  };

  // Trigger rating fetch if game is already finished on load
  useEffect(() => {
    if (status === "finished" && game.rated && isPlayer) {
      void fetchRatingChange();
    }
  }, [status]);

  useEffect(() => {
    const socket = getSocket();

    // Join room
    if (isPlayer) {
      socket.emit("game:join", { gameId });
    } else {
      socket.emit("game:spectate", { gameId });
    }

    // Handlers
    socket.on("game:state", (state: GameState) => {
      setGame(state);
      setFen(state.fen);
      setLastValidFen(state.fen);
      setPgn(state.pgn || "");
      setStatus(state.status);
      setResult(state.result);
      setTerminatedBy(state.terminatedBy);
      setWhiteTime(state.whiteTimeMs);
      setBlackTime(state.blackTimeMs);
    });

    socket.on("game:update", (state: GameState) => {
      setGame(state);
      setFen(state.fen);
      setLastValidFen(state.fen);
      setPgn(state.pgn || "");
      setStatus(state.status);
      setResult(state.result);
      setTerminatedBy(state.terminatedBy);
      setWhiteTime(state.whiteTimeMs);
      setBlackTime(state.blackTimeMs);
    });

    socket.on("game:end", (state: GameState) => {
      setGame(state);
      setFen(state.fen);
      setLastValidFen(state.fen);
      setPgn(state.pgn || "");
      setStatus(state.status);
      setResult(state.result);
      setTerminatedBy(state.terminatedBy);
      setWhiteTime(state.whiteTimeMs);
      setBlackTime(state.blackTimeMs);
      setDrawOffer(null);

      if (state.rated && isPlayer) {
        void fetchRatingChange();
      }
    });

    socket.on("game:draw-offered", (payload: { gameId: string; offeredBy: string }) => {
      if (payload.offeredBy !== userId) {
        setDrawOffer(payload);
      }
    });

    socket.on("game:draw-declined", () => {
      setDrawOffer(null);
    });

    socket.on("game:move-invalid", () => {
      // Flash board red
      setFlashRed(true);
      setTimeout(() => setFlashRed(false), 500);
      // Revert FEN
      if (lastValidFen) {
        setFen(lastValidFen);
      }
    });

    return () => {
      socket.off("game:state");
      socket.off("game:update");
      socket.off("game:end");
      socket.off("game:draw-offered");
      socket.off("game:draw-declined");
      socket.off("game:move-invalid");
    };
  }, [gameId, isPlayer, userId, lastValidFen]);

  const handleMove = (from: string, to: string, promotion?: string) => {
    if (!isOngoing || isSpectator) return;

    // Optimistically update board locally
    const chess = new Chess(fen);
    try {
      const move = chess.move({ from, to, promotion });
      if (move) {
        const prevFen = fen;
        setFen(chess.fen());
        setLastValidFen(prevFen);

        const socket = getSocket();
        socket.emit("game:move", { gameId, from, to, promotion });
      }
    } catch (e) {
      // Should not happen now that ChessBoard pre-validates, but never throw a
      // dev-overlay error for a mere illegal move — just ignore it.
      console.warn("Ignored illegal move", e);
    }
  };

  const handleResign = () => {
    const socket = getSocket();
    socket.emit("game:resign", { gameId });
  };

  const handleDrawOffer = () => {
    const socket = getSocket();
    socket.emit("game:draw-offer", { gameId });
  };

  const handleAbort = () => {
    const socket = getSocket();
    socket.emit("game:abort", { gameId });
  };

  // Fired when a clock hits zero. The server re-validates the real remaining
  // time before ending the game, so this is safe to emit from either client.
  const handleTimeout = () => {
    if (!isOngoing) return;
    const socket = getSocket();
    socket.emit("game:timeout", { gameId });
  };

  const handleAcceptDraw = () => {
    const socket = getSocket();
    socket.emit("game:draw-accept", { gameId });
    setDrawOffer(null);
  };

  const handleDeclineDraw = () => {
    const socket = getSocket();
    socket.emit("game:draw-decline", { gameId });
    setDrawOffer(null);
  };

  // Determine game results details
  const isVictory = result && ((result === "white" && userId === game.white) || (result === "black" && userId === game.black));
  const isDefeat = result && ((result === "white" && userId === game.black) || (result === "black" && userId === game.white));
  const isDraw = result === "draw";

  const getResultTitle = () => {
    if (isVictory) return "Victory!";
    if (isDefeat) return "Defeat";
    if (isDraw) return "Draw";
    if (status === "aborted") return "Game Aborted";
    return "Game Ended";
  };

  const getTerminationReason = () => {
    if (!terminatedBy) return "";
    const mapping: Record<string, string> = {
      timeout: "on time",
      checkmate: "by checkmate",
      stalemate: "by stalemate",
      insufficient: "by insufficient material",
      resign: "by resignation",
      "draw-agreement": "by draw agreement",
      abort: "by abort",
    };
    return mapping[terminatedBy] || `by ${terminatedBy}`;
  };

  return (
    <div className="flex flex-col min-h-screen bg-kca-black text-kca-white">
      {/* Header */}
      <header className="flex items-center justify-between px-6 py-4 border-b border-kca-border bg-kca-surface">
        <Link href={dashboardHref} className="flex items-center gap-3">
          <Image src="/kca-logo.png" alt="KCA" width={36} height={36} className="h-9 w-9 object-contain" />
          <span className="font-display font-bold text-lg text-kca-white">Kamath Chess Academy</span>
        </Link>
        {isSpectator ? (
          <span className="bg-kca-cyan/20 border border-kca-cyan/50 text-kca-cyan px-3.5 py-1.5 rounded-full text-xs font-bold uppercase tracking-wider animate-pulse">
            Spectating
          </span>
        ) : (
          <span className="flex items-center gap-2 bg-kca-surface-2 border border-kca-border px-3.5 py-1.5 rounded-full text-xs font-semibold text-kca-gray-100">
            <span className="text-kca-gray-400 uppercase tracking-wider">Playing as</span>
            <span className="text-kca-white">{username}</span>
            <span className={cn("h-2.5 w-2.5 rounded-full border", orientation === "white" ? "bg-white border-kca-border-bright" : "bg-black border-kca-gray-400")} />
            <span className="text-kca-cyan uppercase tracking-wider">{orientation}</span>
          </span>
        )}
      </header>

      {/* Main layout grid */}
      <main className="flex-1 flex flex-col lg:flex-row gap-6 p-4 md:p-6 max-w-7xl mx-auto w-full items-stretch justify-center">
        {/* Chessboard Column */}
        <div className="flex-1 flex flex-col justify-center max-w-[560px] mx-auto w-full gap-4">
          {/* Opponent Bar */}
          <div className="flex items-center justify-between p-3 bg-kca-surface border border-kca-border rounded-xl">
            <div className="flex items-center gap-3">
              <div className="h-9 w-9 rounded-full bg-kca-border border border-kca-border-bright flex items-center justify-center text-sm font-bold text-kca-cyan">
                {opponentName ? opponentName[0]?.toUpperCase() : "?"}
              </div>
              <div>
                <div className="text-sm font-semibold text-kca-white">{opponentName || "Opponent"}</div>
                <div className="text-xs text-kca-gray-400">Blitz Rating: {opponentRating || 1500}</div>
              </div>
            </div>
            <GameClock
              timeMs={orientation === "white" ? blackTime : whiteTime}
              isActive={orientation === "white" ? blackClockActive : whiteClockActive}
              onExpire={handleTimeout}
            />
          </div>

          {/* Chessboard Wrapper */}
          <div
            className={cn(
              "aspect-square w-full max-w-[560px] bg-kca-surface border border-kca-border rounded-2xl overflow-hidden p-1.5 transition-all duration-300 shadow-cyan-sm hover:shadow-cyan-md",
              flashRed && "ring-4 ring-kca-danger shadow-[0_0_30px_rgba(239,68,68,0.5)] border-kca-danger scale-[1.01]"
            )}
          >
            <ChessBoard
              fen={fen}
              orientation={orientation}
              onMove={handleMove}
              disabled={initialIsFinished || isSpectator || !isOngoing || (orientation === "white" && game.turn === "b") || (orientation === "black" && game.turn === "w")}
              lastMove={lastMove}
            />
          </div>

          {/* Player Bar */}
          <div className="flex items-center justify-between p-3 bg-kca-surface border border-kca-border rounded-xl">
            <div className="flex items-center gap-3">
              <div className="h-9 w-9 rounded-full bg-kca-cyan/20 border border-kca-cyan/40 flex items-center justify-center text-sm font-bold text-kca-cyan select-none">
                {userName ? userName[0]?.toUpperCase() : "?"}
              </div>
              <div>
                <div className="text-sm font-semibold text-kca-white">{userName || "You"}</div>
                <div className="text-xs text-kca-gray-400">Blitz Rating: {userRating || 1500}</div>
              </div>
            </div>
            <GameClock
              timeMs={orientation === "white" ? whiteTime : blackTime}
              isActive={orientation === "white" ? whiteClockActive : blackClockActive}
              onExpire={handleTimeout}
            />
          </div>
        </div>

        {/* Right Sidebar Column */}
        <div className="w-full lg:w-[380px] flex flex-col gap-4 justify-between lg:max-h-[690px]">
          {/* Moves list card */}
          <div className="flex-1 min-h-[300px] flex flex-col bg-kca-surface border border-kca-border rounded-xl overflow-hidden shadow-sm">
            <div className="border-b border-kca-border p-4 bg-kca-surface-2">
              <h3 className="text-sm font-bold text-kca-white tracking-wide uppercase select-none">
                Move Log
              </h3>
            </div>
            <div className="flex-1 overflow-y-auto p-4 bg-kca-black/10">
              <MoveList moves={game.moves || []} />
            </div>
          </div>

          {/* Draw offer notification banner */}
          {drawOffer && (
            <div className="bg-kca-cyan/15 border border-kca-cyan/40 p-4 rounded-xl flex flex-col gap-3 shadow-cyan-sm animate-pulse">
              <div className="text-sm text-kca-white font-semibold">
                Opponent offered a draw.
              </div>
              <div className="flex gap-2">
                <button
                  onClick={handleAcceptDraw}
                  className="btn-primary py-2 px-4 text-xs flex-1 cursor-pointer"
                >
                  Accept
                </button>
                <button
                  onClick={handleDeclineDraw}
                  className="btn-secondary py-2 px-4 text-xs flex-1 cursor-pointer border border-kca-cyan text-kca-cyan hover:bg-kca-cyan/10"
                >
                  Decline
                </button>
              </div>
            </div>
          )}

          {/* Game controls card */}
          {isPlayer && isOngoing && (
            <div className="bg-kca-surface border border-kca-border rounded-xl p-4 shadow-sm">
              <GameControls
                onResign={handleResign}
                onDrawOffer={handleDrawOffer}
                onAbort={handleAbort}
                canAbort={canAbort}
                drawOffered={Boolean(drawOffer)}
                isMyTurn={(orientation === "white" && game.turn === "w") || (orientation === "black" && game.turn === "b")}
              />
            </div>
          )}
        </div>
      </main>

      {/* Game End Modal */}
      {(status === "finished" || status === "aborted") && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-kca-black/90 backdrop-blur-md transition-all duration-300">
          <div className="card w-96 text-center flex flex-col gap-5 border border-kca-cyan shadow-cyan-md bg-kca-surface p-8 max-w-[90%]">
            <div>
              <h2
                className={cn(
                  "text-3xl font-bold font-display tracking-wide uppercase",
                  isVictory
                    ? "text-kca-success"
                    : isDefeat
                    ? "text-kca-danger"
                    : "text-kca-white"
                )}
              >
                {getResultTitle()}
              </h2>
              <p className="text-xs text-kca-gray-400 mt-2 lowercase select-none">
                {getTerminationReason()}
              </p>
            </div>

            {/* Rating Change display */}
            {game.rated && isPlayer && (
              <div className="flex flex-col items-center justify-center p-3 bg-kca-black/40 rounded-lg border border-kca-border select-none">
                <span className="text-xs text-kca-gray-400 uppercase tracking-wider font-semibold">
                  New Rating
                </span>
                {ratingChange !== null ? (
                  <span
                    className={cn(
                      "text-xl font-bold font-mono mt-1",
                      ratingChange >= 0 ? "text-kca-success" : "text-kca-danger"
                    )}
                  >
                    {userRating + ratingChange} (
                    {ratingChange >= 0 ? `+${ratingChange}` : ratingChange})
                  </span>
                ) : (
                  <span className="text-kca-cyan animate-pulse mt-1 text-sm font-semibold">
                    Calculating...
                  </span>
                )}
              </div>
            )}

            <div className="flex flex-col gap-3 mt-2">
              <Link href="/dashboard/play" className="btn-primary w-full py-3.5 font-bold">
                New Game
              </Link>
              <Link
                href={`/dashboard/analysis?gameId=${gameId}`}
                className="btn-secondary w-full py-3.5 font-bold text-center border border-kca-cyan/30 text-kca-cyan hover:bg-kca-cyan/10"
              >
                Analyse Game
              </Link>
              <Link
                href={dashboardHref}
                className="w-full py-2.5 text-center text-sm font-semibold text-kca-gray-400 hover:text-kca-white transition-colors"
              >
                Exit to Dashboard
              </Link>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
