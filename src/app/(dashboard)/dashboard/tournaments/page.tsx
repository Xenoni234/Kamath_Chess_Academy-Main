"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Trophy, Plus, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useHasRole } from "@/components/auth/RoleContext";
import { fetchWithAuth } from "@/lib/http/fetchWithAuth";

type Tournament = {
  id: string;
  title: string;
  type: "ARENA" | "SWISS" | "ROUND_ROBIN";
  status: "UPCOMING" | "ONGOING" | "FINISHED" | "CANCELLED";
  startsAt: string;
  playerCount: number;
};

const TYPE_LABEL: Record<string, string> = { ARENA: "Arena", SWISS: "Swiss", ROUND_ROBIN: "Round Robin" };
const STATUS_STYLE: Record<string, string> = {
  UPCOMING: "bg-kca-cyan/10 text-kca-cyan border-kca-cyan/30",
  ONGOING: "bg-kca-success/10 text-kca-success border-kca-success/30",
  FINISHED: "bg-kca-gray-600/20 text-kca-gray-100 border-kca-gray-600/30",
  CANCELLED: "bg-kca-danger/10 text-kca-danger border-kca-danger/30",
};

export default function TournamentsPage() {
  const [tournaments, setTournaments] = useState<Tournament[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [title, setTitle] = useState("");
  const [type, setType] = useState<"ARENA" | "SWISS" | "ROUND_ROBIN">("SWISS");
  const [startsAt, setStartsAt] = useState("");

  /**
   * Public promotion, collapsed by default.
   *
   * Most tournaments here are internal — a Sunday arena for the batch — and should not
   * appear on the academy's front page. Opening this panel is the decision to advertise;
   * leaving it shut keeps the common case a three-field form.
   */
  const [promote, setPromote] = useState(false);
  const [pub, setPub] = useState({
    isOffline: false,
    prizePool: "",
    formatNote: "",
    venue: "",
    entryFee: "",
    contactInfo: "",
  });

  async function reload() {
    const res = await fetchWithAuth("/api/tournaments");
    const data = await res.json();
    if (data.success) setTournaments(data.tournaments);
  }

  useEffect(() => {
    fetchWithAuth("/api/tournaments")
      .then((r) => r.json())
      .then((t) => {
        if (t.success) setTournaments(t.tournaments);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  // From context, not a fetch: the server already knew this, so the manager
  // controls render correctly on the first paint instead of popping in late.
  const isManager = useHasRole("HR", "HEAD");

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim() || !startsAt) return;
    setCreating(true);
    try {
      const res = await fetchWithAuth("/api/tournaments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, type, startsAt, publicListed: promote, ...pub }),
      });
      if (res.ok) {
        setTitle("");
        setStartsAt("");
        setPromote(false);
        setPub({ isOffline: false, prizePool: "", formatNote: "", venue: "", entryFee: "", contactInfo: "" });
        setShowForm(false);
        await reload();
      }
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="w-full max-w-4xl mx-auto">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-display font-bold text-kca-white mb-2">Tournaments</h1>
          <p className="text-sm text-kca-gray-400">Arena, Swiss and Round Robin events with live standings.</p>
        </div>
        {isManager && (
          <button onClick={() => setShowForm((s) => !s)} className="btn-primary py-2 px-4">
            <Plus className="w-4 h-4" /> New
          </button>
        )}
      </div>

      {isManager && showForm && (
        <form onSubmit={create} className="card p-5 border border-kca-border bg-kca-surface mb-6 grid gap-3 md:grid-cols-4 md:items-end">
          <div className="md:col-span-2">
            <label className="block text-xs font-semibold uppercase tracking-wider text-kca-gray-400 mb-1.5">Title</label>
            <input className="input-field py-2 text-sm" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Sunday Blitz Arena" required />
          </div>
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider text-kca-gray-400 mb-1.5">Format</label>
            <select className="input-field py-2 text-sm" value={type} onChange={(e) => setType(e.target.value as typeof type)}>
              <option value="SWISS">Swiss</option>
              <option value="ROUND_ROBIN">Round Robin</option>
              <option value="ARENA">Arena</option>
            </select>
          </div>
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider text-kca-gray-400 mb-1.5">Starts</label>
            <input type="datetime-local" className="input-field py-2 text-sm" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} required />
          </div>
          {/* --- Public promotion ------------------------------------------------ */}
          <div className="md:col-span-4 border-t border-kca-border pt-4">
            <label className="flex cursor-pointer items-center gap-2.5 text-sm text-kca-gray-100">
              <input
                type="checkbox"
                checked={promote}
                onChange={(e) => setPromote(e.target.checked)}
                className="h-4 w-4 accent-kca-cyan"
              />
              Advertise this on the public homepage
            </label>

            {promote && (
              <div className="mt-4 grid gap-3 md:grid-cols-3">
                <label className="flex items-center gap-2.5 text-sm text-kca-gray-100 md:col-span-3">
                  <input
                    type="checkbox"
                    checked={pub.isOffline}
                    onChange={(e) => setPub((v) => ({ ...v, isOffline: e.target.checked }))}
                    className="h-4 w-4 accent-kca-cyan"
                  />
                  This is an over-the-board event, not played on the site
                </label>

                <div>
                  <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-kca-gray-400">
                    Format shown publicly
                  </label>
                  <input
                    className="input-field py-2 text-sm"
                    value={pub.formatNote}
                    onChange={(e) => setPub((v) => ({ ...v, formatNote: e.target.value }))}
                    placeholder="9 Rounds Swiss · Blitz 3+2"
                  />
                </div>
                <div>
                  <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-kca-gray-400">
                    Prize pool
                  </label>
                  <input
                    className="input-field py-2 text-sm"
                    value={pub.prizePool}
                    onChange={(e) => setPub((v) => ({ ...v, prizePool: e.target.value }))}
                    placeholder="Leave blank if there is none"
                  />
                </div>
                <div>
                  <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-kca-gray-400">
                    Entry fee
                  </label>
                  <input
                    className="input-field py-2 text-sm"
                    value={pub.entryFee}
                    onChange={(e) => setPub((v) => ({ ...v, entryFee: e.target.value }))}
                    placeholder="₹500"
                  />
                </div>
                <div className="md:col-span-2">
                  <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-kca-gray-400">
                    Venue
                  </label>
                  <input
                    className="input-field py-2 text-sm"
                    value={pub.venue}
                    onChange={(e) => setPub((v) => ({ ...v, venue: e.target.value }))}
                    placeholder="Hall name, area, city"
                  />
                </div>
                <div>
                  <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-kca-gray-400">
                    Contact
                  </label>
                  <input
                    className="input-field py-2 text-sm"
                    value={pub.contactInfo}
                    onChange={(e) => setPub((v) => ({ ...v, contactInfo: e.target.value }))}
                    placeholder="Phone or email"
                  />
                </div>

                <p className="md:col-span-3 text-xs text-kca-gray-400">
                  The homepage shows only the title, date, format and prize. Venue, entry fee and
                  contact are sent only to signed-in users — visitors see “Sign in for details”.
                </p>
              </div>
            )}
          </div>

          <button type="submit" disabled={creating} className="btn-primary py-2.5 md:col-span-4 disabled:opacity-50">
            {creating ? <Loader2 className="w-4 h-4 animate-spin" /> : "Create tournament"}
          </button>
        </form>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-16 text-kca-gray-400">
          <Loader2 className="w-6 h-6 animate-spin text-kca-cyan" />
        </div>
      ) : tournaments.length === 0 ? (
        <div className="card p-10 text-center text-kca-gray-400 border border-kca-border bg-kca-surface">
          <Trophy className="w-8 h-8 mx-auto mb-3 opacity-20" />
          <p>No tournaments yet.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {tournaments.map((t) => (
            <Link
              key={t.id}
              href={`/dashboard/tournaments/${t.id}`}
              className="card p-5 border border-kca-border bg-kca-surface flex items-center justify-between gap-4 hover:border-kca-cyan/50 transition-colors block"
            >
              <div>
                <div className="text-lg font-semibold text-kca-white">{t.title}</div>
                <div className="text-sm text-kca-gray-400 mt-1">
                  {TYPE_LABEL[t.type]} · {t.playerCount} players · {new Date(t.startsAt).toLocaleString()}
                </div>
              </div>
              <span className={cn("shrink-0 rounded-full border px-3 py-1 text-[10px] font-bold uppercase tracking-wider", STATUS_STYLE[t.status])}>
                {t.status}
              </span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
