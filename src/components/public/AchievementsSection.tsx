"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import { Trophy } from "lucide-react";

/**
 * "Our Champions" — two lines that scroll together.
 *
 * **HARD RULE #2 EXCEPTION, on the academy owner's instruction.** This file held six
 * hardcoded entries — Aditya Mittal, Nihal Sarin, Divya Deshmukh, Leon Mendonca, Pranav V
 * and Savitha Shri B — presented as "our elite academy students". Those are well-known
 * titled Indian players, and the claim was live on a site parents read while choosing a
 * chess academy for their child. Whether or not any of them trained here, a claim about a
 * real person should be made by the person answerable for it, not left in a component only
 * a developer can change.
 *
 * Two rows rather than one because there are more students than coaches, and a single
 * strip of forty cards is a very long loop. They share one animation so the pair reads as
 * a single moving block rather than two strips at different speeds.
 */

type Achievement = {
  id: string;
  name: string;
  achievement: string;
  achievedOn: string;
  hasPhoto: boolean;
};

function Card({ item, duplicate }: { item: Achievement; duplicate: boolean }) {
  return (
    <div aria-hidden={duplicate} className="card flex w-80 shrink-0 flex-col justify-between">
      <div>
        {item.hasPhoto ? (
          <div className="mb-6 h-20 w-20 overflow-hidden rounded-lg border border-kca-cyan/20">
            <Image
              src={`/api/public/photo/achievement/${item.id}`}
              alt={duplicate ? "" : item.name}
              width={80}
              height={80}
              unoptimized
              className="h-full w-full object-cover"
            />
          </div>
        ) : (
          <div className="mb-6 flex h-12 w-12 items-center justify-center rounded-lg border border-kca-cyan/20 bg-kca-cyan/10">
            <Trophy className="h-6 w-6 text-kca-cyan" />
          </div>
        )}

        <h3 className="mb-2 font-display text-xl font-bold text-kca-white">{item.name}</h3>
        <p className="mb-6 font-sans text-sm leading-relaxed text-kca-gray-400">{item.achievement}</p>
      </div>

      <div className="font-display text-xs font-semibold uppercase tracking-wider text-kca-cyan">
        {new Date(item.achievedOn).toLocaleDateString("en-IN", { month: "long", year: "numeric" })}
      </div>
    </div>
  );
}

export default function AchievementsSection() {
  const [achievements, setAchievements] = useState<Achievement[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    fetch("/api/public/site")
      .then((r) => r.json())
      .then((d) => setAchievements(d?.achievements ?? []))
      .catch(() => setAchievements([]))
      .finally(() => setLoaded(true));
  }, []);

  // Nothing to celebrate yet is not a reason to invent something. An absent section reads
  // better than an empty heading — and better than filler, which is what this replaced.
  if (!loaded || achievements.length === 0) return null;

  // Split across two rows. With an odd count the top row takes the extra, so a single
  // entry still appears rather than landing in an empty second row.
  const half = Math.ceil(achievements.length / 2);
  const rows = [achievements.slice(0, half), achievements.slice(half)].filter((r) => r.length > 0);

  // One duration for both rows — that is what makes them read as one block.
  const duration = `${Math.max(28, half * 8)}s`;

  return (
    <section id="achievements" className="relative overflow-hidden bg-[#0D0D0D] px-6 py-20 md:px-8">
      <div
        className="pointer-events-none absolute bottom-0 right-0 h-96 w-96"
        style={{ backgroundImage: "radial-gradient(circle, rgba(0, 200, 232, 0.05) 0%, transparent 70%)" }}
      />

      <div className="relative z-10">
        <div className="mx-auto mb-16 max-w-7xl text-center md:text-left">
          <h2 className="section-heading">Our Champions</h2>
          <p className="section-subheading mt-4">
            Celebrating the milestones and victories of our students.
          </p>
        </div>

        <div className="space-y-6">
          {rows.map((row, rowIndex) => (
            <div
              key={rowIndex}
              className="kca-marquee"
              style={{ "--kca-marquee-duration": duration } as React.CSSProperties}
            >
              <div className="kca-marquee-track gap-8 px-4 py-2">
                {[0, 1].map((copy) =>
                  row.map((item) => (
                    <Card key={`${copy}-${item.id}`} item={item} duplicate={copy === 1} />
                  )),
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
