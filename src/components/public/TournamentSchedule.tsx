import { Calendar, Trophy, ChevronRight } from "lucide-react";

interface Tournament {
  title: string;
  date: string;
  prizePool: string;
  format: string;
}

export default function TournamentSchedule() {
  const tournaments: Tournament[] = [
    {
      title: "KCA Summer Blitz Open",
      date: "July 12, 2026",
      prizePool: "₹50,000",
      format: "9 Rounds Swiss • Blitz 3+2",
    },
    {
      title: "Grandmaster Masterclass & Rapid Arena",
      date: "July 28, 2026",
      prizePool: "₹1,00,000",
      format: "7 Rounds Swiss • Rapid 10+5",
    },
    {
      title: "KCA Junior Under-16 Championship",
      date: "August 15, 2026",
      prizePool: "Scholarships & Trophies",
      format: "5 Rounds Swiss • Classical 30+30",
    },
  ];

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
          {tournaments.map((tournament, index) => (
            <div
              key={index}
              className="group flex flex-col md:flex-row md:items-center justify-between border border-kca-border bg-kca-surface hover:border-kca-cyan p-6 rounded-xl transition-all duration-300 hover:shadow-cyan-sm"
            >
              {/* Left Side: Date and Event Details */}
              <div className="flex flex-col sm:flex-row sm:items-center gap-6">
                {/* Date Box */}
                <div className="flex flex-col items-center justify-center bg-kca-black border border-kca-border group-hover:border-kca-cyan/40 px-4 py-3 rounded-lg text-center min-w-[120px] transition-colors duration-300">
                  <Calendar className="h-5 w-5 text-kca-cyan mb-1" />
                  <span className="font-display text-xs font-semibold text-kca-gray-400 uppercase">
                    {tournament.date.split(",")[0]}
                  </span>
                  <span className="font-display text-xs font-semibold text-kca-cyan mt-0.5">
                    {tournament.date.split(",")[1]?.trim()}
                  </span>
                </div>

                {/* Details */}
                <div>
                  <h3 className="font-display text-lg font-bold text-kca-white group-hover:text-kca-cyan transition-colors">
                    {tournament.title}
                  </h3>
                  <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 font-sans text-sm text-kca-gray-400">
                    <span>{tournament.format}</span>
                    <span className="hidden sm:inline text-kca-border">•</span>
                    <span className="flex items-center gap-1.5">
                      <Trophy className="h-4 w-4 text-amber-500" />
                      Prize Pool: <strong className="text-kca-white font-semibold">{tournament.prizePool}</strong>
                    </span>
                  </div>
                </div>
              </div>

              {/* Right Side: Action Button */}
              <div className="mt-6 md:mt-0">
                <a
                  href="#contact"
                  className="inline-flex items-center gap-2 rounded-lg bg-kca-black border border-kca-border group-hover:border-kca-cyan group-hover:bg-kca-cyan group-hover:text-kca-black text-kca-cyan font-display text-sm font-bold px-5 py-2.5 transition-all duration-300"
                >
                  Register Now
                  <ChevronRight className="h-4 w-4" />
                </a>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
