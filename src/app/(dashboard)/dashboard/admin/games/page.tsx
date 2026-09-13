"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import { fetchWithAuth } from "@/lib/http/fetchWithAuth";

type Game = {
  id: string;
  createdAt: string;
  white: string;
  black: string;
  result: string;
  termination: string | null;
  timeControl: string | null;
  format: string;
  rated: boolean;
  moveCount: number;
};

/** What the Head dashboard's "Games Played" number is counting. */
export default function AdminGamesPage() {
  const [games, setGames] = useState<Game[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (after?: string) => {
    try {
      const url = after ? `/api/admin/games?limit=50&cursor=${after}` : "/api/admin/games?limit=50";
      const res = await fetchWithAuth(url);
      const data = await res.json();
      if (!res.ok || !data.success) {
        setError(data.message ?? "Could not load games.");
        return;
      }
      setGames((prev) => (after ? [...prev, ...data.games] : data.games));
      setCursor(data.nextCursor);
    } catch {
      setError("Could not load games.");
    } finally {
      setLoading(false);
      setMore(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const winner = (g: Game) => {
    if (g.result === "WHITE_WIN") return `${g.white} won`;
    if (g.result === "BLACK_WIN") return `${g.black} won`;
    if (g.result === "DRAW") return "Draw";
    return "Aborted";
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-16 text-sm text-kca-gray-400">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading games…
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-[1400px]">
      <h1 className="section-heading">Games</h1>
      <p className="section-subheading mb-6">
        Every game played on the platform, newest first. {games.length} shown.
      </p>

      {error && <p className="mb-4 text-sm text-kca-danger">{error}</p>}

      {games.length === 0 ? (
        <div className="card text-center text-sm text-kca-gray-400">No games have been played yet.</div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-kca-border bg-kca-surface">
          <table className="w-full min-w-[48rem] text-left text-sm">
            <thead className="border-b border-kca-border bg-kca-surface-2 text-xs uppercase tracking-wider text-kca-gray-400">
              <tr>
                <th className="px-4 py-3">When</th>
                <th className="px-4 py-3">White</th>
                <th className="px-4 py-3">Black</th>
                <th className="px-4 py-3">Result</th>
                <th className="px-4 py-3">Time</th>
                <th className="px-4 py-3 text-right">Moves</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {games.map((g) => (
                <tr key={g.id} className="border-b border-kca-border/50 last:border-0 hover:bg-kca-surface-2">
                  <td className="whitespace-nowrap px-4 py-3 text-kca-gray-400">
                    {new Date(g.createdAt).toLocaleString("en-IN", {
                      day: "numeric",
                      month: "short",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </td>
                  <td className="px-4 py-3 text-kca-white">{g.white}</td>
                  <td className="px-4 py-3 text-kca-white">{g.black}</td>
                  <td className="px-4 py-3 text-kca-gray-100">
                    {winner(g)}
                    {g.termination && <span className="text-kca-gray-400"> · {g.termination}</span>}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 font-mono text-xs text-kca-gray-400">
                    {g.timeControl ?? "—"} {g.rated ? "" : "· casual"}
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-kca-gray-400">{g.moveCount}</td>
                  <td className="px-4 py-3 text-right">
                    <Link href={`/game/${g.id}`} className="text-xs text-kca-cyan hover:underline">
                      Open
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {cursor && (
        <button
          type="button"
          disabled={more}
          onClick={() => {
            setMore(true);
            void load(cursor);
          }}
          className="btn-secondary mt-4 disabled:opacity-50"
        >
          {more ? "Loading…" : "Load more"}
        </button>
      )}
    </div>
  );
}
