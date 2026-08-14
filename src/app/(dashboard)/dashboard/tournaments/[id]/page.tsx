"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { Trophy, ArrowLeft, Loader2, Play, SkipForward, Flag, Check } from "lucide-react";
import { getSocket } from "@/lib/socket/client";
import { cn } from "@/lib/utils";

type Standing = { rank: number; userId?: string; username: string; score: number };
type Detail = {
  id: string;
  title: string;
  description: string | null;
  type: "ARENA" | "SWISS" | "ROUND_ROBIN";
  status: "UPCOMING" | "ONGOING" | "FINISHED" | "CANCELLED";
  startsAt: string;
  joined: boolean;
  standings: Standing[];
};

const TYPE_LABEL: Record<string, string> = { ARENA: "Arena", SWISS: "Swiss", ROUND_ROBIN: "Round Robin" };
const STATUS_STYLE: Record<string, string> = {
  UPCOMING: "bg-kca-cyan/10 text-kca-cyan border-kca-cyan/30",
  ONGOING: "bg-kca-success/10 text-kca-success border-kca-success/30",
  FINISHED: "bg-kca-gray-600/20 text-kca-gray-100 border-kca-gray-600/30",
  CANCELLED: "bg-kca-danger/10 text-kca-danger border-kca-danger/30",
};

export default function TournamentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [t, setT] = useState<Detail | null>(null);
  const [standings, setStandings] = useState<Standing[]>([]);
  const [role, setRole] = useState("");
  const [round, setRound] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // Drives which branch renders, so it has to be state — a ref read during
  // render would not re-render when the lookup fails.
  const [notFound, setNotFound] = useState(false);

  const load = useCallback(async () => {
    const [detail, me] = await Promise.all([
      fetch(`/api/tournaments/${id}`).then((r) => r.json()),
      fetch("/api/auth/me").then((r) => r.json()),
    ]);
    if (detail.success) {
      setT(detail.tournament);
      setStandings(detail.tournament.standings);
    } else {
      setNotFound(true);
    }
    if (me.success) setRole(me.user.role);
  }, [id]);

  useEffect(() => {
    // `cancelled` stops the initial load from clearing the spinner after unmount.
    let cancelled = false;

    async function initialLoad() {
      await load();
      if (!cancelled) setLoading(false);
    }

    void initialLoad();
    return () => {
      cancelled = true;
    };
  }, [load]);

  // Live socket: watch the tournament room, react to pairings and leaderboard.
  useEffect(() => {
    const socket = getSocket();
    socket.emit("tournament:watch", { tournamentId: id });

    const onLeaderboard = (p: { tournamentId: string; standings: Standing[] }) => {
      if (p.tournamentId === id) setStandings(p.standings);
    };
    const onPairing = (p: { tournamentId: string; gameId: string }) => {
      if (p.tournamentId === id) router.push(`/game/${p.gameId}`);
    };
    const onRound = (p: { tournamentId: string; round: number }) => {
      if (p.tournamentId === id) {
        setRound(p.round);
        load();
      }
    };
    const onFinished = (p: { tournamentId: string }) => {
      if (p.tournamentId === id) load();
    };

    socket.on("tournament:leaderboard", onLeaderboard);
    socket.on("tournament:pairing", onPairing);
    socket.on("tournament:round", onRound);
    socket.on("tournament:finished", onFinished);

    return () => {
      socket.emit("tournament:unwatch", { tournamentId: id });
      socket.off("tournament:leaderboard", onLeaderboard);
      socket.off("tournament:pairing", onPairing);
      socket.off("tournament:round", onRound);
      socket.off("tournament:finished", onFinished);
    };
  }, [id, router, load]);

  async function post(path: string) {
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`/api/tournaments/${id}/${path}`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) setError(data.message || "Action failed.");
      await load();
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20 text-kca-gray-400">
        <Loader2 className="w-6 h-6 animate-spin text-kca-cyan" />
      </div>
    );
  }

  if (!t || notFound) {
    return (
      <div className="max-w-3xl mx-auto text-center py-20 text-kca-gray-400">
        <p className="mb-4">Tournament not found.</p>
        <Link href="/dashboard/tournaments" className="text-kca-cyan hover:underline">Back to tournaments</Link>
      </div>
    );
  }

  const isManager = role === "HR" || role === "HEAD";

  return (
    <div className="w-full max-w-3xl mx-auto">
      <Link href="/dashboard/tournaments" className="inline-flex items-center gap-1.5 text-sm text-kca-gray-400 hover:text-kca-white mb-4">
        <ArrowLeft className="w-4 h-4" /> Tournaments
      </Link>

      <div className="card p-6 border border-kca-border bg-kca-surface mb-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-display font-bold text-kca-white">{t.title}</h1>
            <p className="text-sm text-kca-gray-400 mt-1">
              {TYPE_LABEL[t.type]} · {new Date(t.startsAt).toLocaleString()}
              {round !== null && t.status === "ONGOING" && <> · Round {round}</>}
            </p>
            {t.description && <p className="text-sm text-kca-gray-300 mt-3">{t.description}</p>}
          </div>
          <span className={cn("shrink-0 rounded-full border px-3 py-1 text-[10px] font-bold uppercase tracking-wider", STATUS_STYLE[t.status])}>
            {t.status}
          </span>
        </div>

        <div className="mt-5 flex flex-wrap items-center gap-3">
          {t.status === "UPCOMING" && !t.joined && (
            <button onClick={() => post("join")} disabled={busy} className="btn-primary py-2 px-4 disabled:opacity-50">
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : "Join tournament"}
            </button>
          )}
          {t.status === "UPCOMING" && t.joined && (
            <span className="inline-flex items-center gap-1.5 text-sm text-kca-success">
              <Check className="w-4 h-4" /> You&apos;re registered
            </span>
          )}
          {t.status === "ONGOING" && (
            <span className="text-sm text-kca-gray-400">Waiting for your next pairing — you&apos;ll be moved to the board automatically.</span>
          )}

          {isManager && t.status === "UPCOMING" && (
            <button onClick={() => post("start")} disabled={busy} className="btn-secondary py-2 px-4 disabled:opacity-50">
              <Play className="w-4 h-4" /> Start
            </button>
          )}
          {isManager && t.status === "ONGOING" && (
            <>
              <button onClick={() => post("next-round")} disabled={busy} className="btn-secondary py-2 px-4 disabled:opacity-50">
                <SkipForward className="w-4 h-4" /> Next round
              </button>
              <button onClick={() => post("finish")} disabled={busy} className="btn-secondary py-2 px-4 disabled:opacity-50">
                <Flag className="w-4 h-4" /> Finish
              </button>
            </>
          )}
        </div>
        {error && <p className="mt-3 text-sm text-kca-danger">{error}</p>}
      </div>

      <div className="card border border-kca-border bg-kca-surface overflow-hidden">
        <div className="flex items-center gap-2 px-5 py-3 border-b border-kca-border">
          <Trophy className="w-4 h-4 text-kca-cyan" />
          <h2 className="text-sm font-semibold text-kca-white uppercase tracking-wider">Standings</h2>
        </div>
        {standings.length === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-kca-gray-400">No players yet.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wider text-kca-gray-500">
                <th className="px-5 py-2 font-medium w-12">#</th>
                <th className="px-5 py-2 font-medium">Player</th>
                <th className="px-5 py-2 font-medium text-right w-20">Score</th>
              </tr>
            </thead>
            <tbody>
              {standings.map((s) => (
                <tr key={s.username} className="border-t border-kca-border/60">
                  <td className="px-5 py-2.5 text-kca-gray-400 font-mono">{s.rank}</td>
                  <td className="px-5 py-2.5 text-kca-white">{s.username}</td>
                  <td className="px-5 py-2.5 text-right font-mono text-kca-white">{s.score}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
