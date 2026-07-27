"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Trophy, ChevronRight, Loader2 } from "lucide-react";

type GameResult = "win" | "loss" | "draw" | "aborted";

interface GameHistoryEntry {
  id: string;
  playedAt: string;
  timeFormat: string;
  timeControl: string;
  result: GameResult;
  ratingChange: number | null;
  opponent: { id: string; username: string } | null;
}

const RESULT_STYLES: Record<GameResult, string> = {
  win: "bg-kca-success/10 text-kca-success border border-kca-success/20",
  loss: "bg-kca-danger/10 text-kca-danger border border-kca-danger/20",
  draw: "bg-kca-gray-600/20 text-kca-gray-100 border border-kca-gray-600/30",
  aborted: "bg-kca-gray-600/20 text-kca-gray-400 border border-kca-gray-600/30",
};

export default function GamesPage() {
  const [games, setGames] = useState<GameHistoryEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;

    fetch("/api/games")
      .then(async (response) => {
        const data = await response.json();
        if (!active) return;
        if (!response.ok || !data.success) {
          setError(data.message ?? "Failed to load games.");
          return;
        }
        setGames(data.games ?? []);
      })
      .catch(() => {
        if (active) setError("Failed to load games.");
      })
      .finally(() => {
        if (active) setIsLoading(false);
      });

    return () => {
      active = false;
    };
  }, []);

  return (
    <div className="w-full max-w-5xl mx-auto">
      <div className="mb-8">
        <h1 className="text-3xl font-display font-bold text-kca-white mb-2">Games</h1>
        <p className="text-sm text-kca-gray-400">Your complete game history across all time formats.</p>
      </div>

      <div className="card p-0 border border-kca-border bg-kca-surface rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm text-left">
            <thead className="text-xs text-kca-gray-400 bg-kca-black/50 uppercase tracking-wider border-b border-kca-border">
              <tr>
                <th className="px-6 py-4 font-semibold">Date</th>
                <th className="px-6 py-4 font-semibold">Format</th>
                <th className="px-6 py-4 font-semibold">Time Control</th>
                <th className="px-6 py-4 font-semibold">Opponent</th>
                <th className="px-6 py-4 font-semibold">Result</th>
                <th className="px-6 py-4 font-semibold">Rating</th>
                <th className="px-6 py-4 font-semibold text-right">Review</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-kca-border/50">
              {games.map((game) => (
                <tr key={game.id} className="hover:bg-kca-surface-2 transition-colors">
                  <td className="px-6 py-4 font-medium text-kca-white whitespace-nowrap">
                    {new Date(game.playedAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}
                  </td>
                  <td className="px-6 py-4 text-kca-gray-100 capitalize">{game.timeFormat.toLowerCase()}</td>
                  <td className="px-6 py-4 text-kca-gray-100 font-mono">{game.timeControl}</td>
                  <td className="px-6 py-4 text-kca-gray-100">{game.opponent?.username ?? "—"}</td>
                  <td className="px-6 py-4">
                    <span className={`px-2 py-1 rounded-md text-[10px] font-bold uppercase tracking-wider ${RESULT_STYLES[game.result]}`}>
                      {game.result}
                    </span>
                  </td>
                  <td className="px-6 py-4">
                    {game.ratingChange == null ? (
                      <span className="text-kca-gray-400">—</span>
                    ) : (
                      <span className={`font-bold ${game.ratingChange > 0 ? "text-kca-success" : game.ratingChange < 0 ? "text-kca-danger" : "text-kca-gray-100"}`}>
                        {game.ratingChange > 0 ? `+${game.ratingChange}` : game.ratingChange}
                      </span>
                    )}
                  </td>
                  <td className="px-6 py-4 text-right">
                    <Link href={`/game/${game.id}`} className="inline-block text-kca-gray-400 hover:text-kca-cyan transition-colors p-2">
                      <ChevronRight className="w-5 h-5" />
                    </Link>
                  </td>
                </tr>
              ))}

              {isLoading && (
                <tr>
                  <td colSpan={7} className="px-6 py-12 text-center text-kca-gray-500">
                    <Loader2 className="w-6 h-6 mx-auto mb-3 animate-spin text-kca-cyan" />
                    <p>Loading your games…</p>
                  </td>
                </tr>
              )}

              {!isLoading && error && (
                <tr>
                  <td colSpan={7} className="px-6 py-12 text-center text-kca-danger text-sm">
                    {error}
                  </td>
                </tr>
              )}

              {!isLoading && !error && games.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-6 py-12 text-center text-kca-gray-500">
                    <Trophy className="w-8 h-8 mx-auto mb-3 opacity-20" />
                    <p>No games played yet.</p>
                    <Link href="/dashboard/play" className="text-kca-cyan text-xs hover:underline mt-2 inline-block">
                      Play your first game
                    </Link>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
