"use client";

import { useEffect, useState } from "react";
import { ArrowRight } from "lucide-react";

/**
 * HARD RULE #2 EXCEPTION, on the academy owner's instruction.
 *
 * These numbers were hardcoded as "500+ Students / 50+ Coaches / 10,000+ Games Played /
 * 15+ Tournaments" on a platform that had nine accounts and one game. Invented figures on
 * a live site, read by parents deciding where to send their child, are not a styling
 * choice — so the data source moved to `/api/public/site` while the layout stayed exactly
 * as designed.
 *
 * Real counts are smaller and true, and they climb on their own as people arrive. The
 * "+" is kept only once a figure is big enough for rounding to mean anything.
 */
export default function HeroSection() {
  const [stats, setStats] = useState<{ value: string; label: string }[] | null>(null);

  useEffect(() => {
    fetch("/api/public/site")
      .then((r) => r.json())
      .then((d) => {
        const s = d?.stats;
        if (!s) return;
        // Round down to a "+" only past 100 — "12+" reads as hiding something, while 12
        // reads as a fact.
        const show = (n: number) => (n >= 100 ? `${Math.floor(n / 100) * 100}+` : String(n));
        setStats([
          { value: show(s.students), label: "Students" },
          { value: show(s.coaches), label: "Coaches" },
          { value: show(s.games), label: "Games Played" },
          { value: show(s.tournaments), label: "Tournaments" },
        ]);
      })
      .catch(() => setStats(null));
  }, []);

  return (
    <section
      id="home"
      className="relative flex min-h-screen flex-col justify-between overflow-hidden bg-kca-black px-6 pt-24 pb-12 md:px-8 lg:pt-36"
    >
      {/* Background Glow Effect */}
      <div 
        className="absolute inset-0 pointer-events-none"
        style={{
          backgroundImage: "radial-gradient(circle at 50% 0%, rgba(0, 200, 232, 0.12) 0%, transparent 50%)",
        }}
      />

      {/* Hero Content */}
      <div className="relative z-10 mx-auto flex max-w-5xl flex-grow flex-col items-center justify-center text-center">

        {/* Main Heading */}
        <h1 className="font-display text-5xl font-black leading-none text-kca-white sm:text-6xl md:text-7xl lg:text-8xl tracking-tight">
          Master the Game. <br className="hidden sm:inline" />
          <span className="bg-gradient-to-r from-kca-cyan to-kca-cyan-bright bg-clip-text text-transparent drop-shadow-[0_0_30px_rgba(0,200,232,0.2)]">
            Master Your Mind.
          </span>
        </h1>

        {/* Subheading */}
        <p className="mt-8 max-w-2xl font-sans text-base leading-relaxed text-kca-gray-400 sm:text-lg md:text-xl">
          A complete training platform: engine analysis, opponent preparation,
          spaced-repetition puzzles and live coaching. Elevate your play from
          amateur to champion.
        </p>

        {/* Action Buttons */}
        <div className="mt-10 flex flex-col items-center justify-center gap-4 sm:flex-row w-full sm:w-auto">
          <a href="#contact" className="btn-primary w-full sm:w-auto text-center px-8 py-4">
            Get Started
            <ArrowRight className="h-5 w-5" />
          </a>
        </div>
      </div>

      {/* Stats Row — hidden until the real numbers arrive. A row of skeletons or zeros
          during load looks worse than no row, and inventing placeholders is exactly what
          this change exists to undo. */}
      {stats && (
      <div className="relative z-10 mx-auto mt-16 w-full max-w-6xl border-t border-kca-border/40 pt-10">
        <div className="grid grid-cols-2 gap-8 md:grid-cols-4">
          {stats.map((stat, index) => (
            <div key={index} className="text-center">
              <div className="font-display text-3xl font-extrabold text-kca-white md:text-4xl lg:text-5xl">
                {stat.value}
              </div>
              <div className="mt-2 font-display text-xs font-medium uppercase tracking-wider text-kca-gray-400">
                {stat.label}
              </div>
            </div>
          ))}
        </div>
      </div>
      )}
    </section>
  );
}
