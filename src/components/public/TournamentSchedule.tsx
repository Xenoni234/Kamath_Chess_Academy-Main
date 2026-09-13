"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Calendar, ChevronRight, MapPin, Trophy } from "lucide-react";

/**
 * Upcoming tournaments on the public homepage.
 *
 * **HARD RULE #2 EXCEPTION, recorded deliberately.** `src/components/public/` is
 * design-final and normally must not be touched. This file was changed on the academy
 * owner's explicit instruction, and for a reason that outweighs the rule: it contained
 * three HARDCODED tournaments — "KCA Summer Blitz Open", a "Grandmaster Masterclass" with
 * a **₹1,00,000 prize pool**, and a Junior Championship — none of which existed. That is
 * not stale copy on a portfolio piece; it is an invented prize fund advertised on a live
 * site to parents choosing a chess academy for their child.
 *
 * The layout, spacing and styling are unchanged. Only the data source moved: from an array
 * literal to `/api/public/tournaments`, which returns tournaments staff actually created
 * and marked as publicly listed.
 *
 * The public endpoint returns only the teaser fields — venue, entry fee and contact details
 * are never selected from the database, so "sign in for the full details" is enforced by
 * the server rather than by this component choosing what to render.
 */

type PublicTournament = {
  id: string;
  title: string;
  startsAt: string;
  type: string;
  formatNote: string | null;
  prizePool: string | null;
  isOffline: boolean;
};

export default function TournamentSchedule() {
  const [tournaments, setTournaments] = useState<PublicTournament[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    fetch("/api/public/tournaments")
      .then((res) => res.json())
      .then((data) => setTournaments(data?.tournaments ?? []))
      .catch(() => setTournaments([]))
      .finally(() => setLoaded(true));
  }, []);

  // Render nothing at all until we know, and nothing if there is nothing. An empty
  // "Upcoming Tournaments" heading over blank space looks more broken than an absent
  // section, and inventing filler is exactly what this change exists to undo.
  if (!loaded || tournaments.length === 0) return null;

  return (
    <section id="schedule" className="bg-[#050505] py-20 px-6 md:px-8 relative overflow-hidden">
      <div className="mx-auto max-w-5xl relative z-10">
        {/* Section Headers */}
        <div className="mb-16 text-center">
          <h2 className="section-heading">Upcoming Tournaments</h2>
          <p className="section-subheading mt-4 mx-auto">
            Test your limits and gain FIDE/Lichess rating points in our structured, competitive academy tournaments.
          </p>
        </div>

        {/* Schedule List */}
        <div className="space-y-4">
          {tournaments.map((tournament) => {
            const when = new Date(tournament.startsAt);
            const month = when.toLocaleDateString("en-IN", { month: "long", day: "numeric" });
            const year = String(when.getFullYear());

            return (
              <div
                key={tournament.id}
                className="group flex flex-col md:flex-row md:items-center justify-between border border-kca-border bg-kca-surface hover:border-kca-cyan p-6 rounded-xl transition-all duration-300 hover:shadow-cyan-sm"
              >
                {/* Left Side: Date and Event Details */}
                <div className="flex flex-col sm:flex-row sm:items-center gap-6">
                  {/* Date Box */}
                  <div className="flex flex-col items-center justify-center bg-kca-black border border-kca-border group-hover:border-kca-cyan/40 px-4 py-3 rounded-lg text-center min-w-[120px] transition-colors duration-300">
                    <Calendar className="h-5 w-5 text-kca-cyan mb-1" />
                    <span className="font-display text-xs font-semibold text-kca-gray-400 uppercase">
                      {month}
                    </span>
                    <span className="font-display text-xs font-semibold text-kca-cyan mt-0.5">{year}</span>
                  </div>

                  {/* Details */}
                  <div>
                    <h3 className="font-display text-lg font-bold text-kca-white group-hover:text-kca-cyan transition-colors">
                      {tournament.title}
                    </h3>
                    <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 font-sans text-sm text-kca-gray-400">
                      <span>{tournament.formatNote ?? tournament.type}</span>
                      {tournament.isOffline && (
                        <>
                          <span className="hidden sm:inline text-kca-border">•</span>
                          <span className="flex items-center gap-1.5">
                            <MapPin className="h-4 w-4 text-kca-cyan" />
                            Over the board
                          </span>
                        </>
                      )}
                      {/* Only rendered when a real prize exists. No prize is not "₹0". */}
                      {tournament.prizePool && (
                        <>
                          <span className="hidden sm:inline text-kca-border">•</span>
                          <span className="flex items-center gap-1.5">
                            <Trophy className="h-4 w-4 text-amber-500" />
                            Prize Pool:{" "}
                            <strong className="text-kca-white font-semibold">{tournament.prizePool}</strong>
                          </span>
                        </>
                      )}
                    </div>
                  </div>
                </div>

                {/* Right Side: Action Button */}
                <div className="mt-6 md:mt-0">
                  <Link
                    href={`/login?next=${encodeURIComponent(`/dashboard/tournaments/${tournament.id}`)}`}
                    className="inline-flex items-center gap-2 rounded-lg bg-kca-black border border-kca-border group-hover:border-kca-cyan group-hover:bg-kca-cyan group-hover:text-kca-black text-kca-cyan font-display text-sm font-bold px-5 py-2.5 transition-all duration-300"
                  >
                    Sign in for details
                    <ChevronRight className="h-4 w-4" />
                  </Link>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
