"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import { UserRound } from "lucide-react";

/**
 * The coaching team — a single continuous line that scrolls.
 *
 * New section, added on the academy owner's instruction, and database-driven from the
 * start. The lesson from "Our Champions" and the invented tournament prize pools is that
 * public claims about real people belong where the person answerable for them can edit
 * them, not in a component only a developer can change.
 *
 * A marquee rather than a grid because there is no fixed number of coaches — the owner
 * adds as many as they have, and a strip absorbs three or thirty without the layout
 * needing to know which.
 *
 * `title` is free text the owner fills in. The academy is responsible for whatever it
 * claims there; this component only renders it.
 */

type Coach = {
  id: string;
  name: string;
  title: string | null;
  bio: string | null;
  hasPhoto: boolean;
};

function CoachCard({ coach, duplicate }: { coach: Coach; duplicate: boolean }) {
  return (
    <div aria-hidden={duplicate} className="card flex w-72 shrink-0 flex-col items-center text-center">
      {coach.hasPhoto ? (
        <div className="mb-5 h-32 w-32 overflow-hidden rounded-full border-2 border-kca-cyan/20">
          <Image
            src={`/api/public/photo/coach/${coach.id}`}
            alt={duplicate ? "" : coach.name}
            width={320}
            height={320}
            unoptimized
            className="h-full w-full object-cover"
          />
        </div>
      ) : (
        <div className="mb-6 flex h-16 w-16 items-center justify-center rounded-full border border-kca-cyan/20 bg-kca-cyan/10">
          <UserRound className="h-8 w-8 text-kca-cyan" />
        </div>
      )}

      <h3 className="font-display text-xl font-bold text-kca-white">{coach.name}</h3>
      {coach.title && (
        <p className="mt-1 font-display text-xs font-semibold uppercase tracking-wider text-kca-cyan">
          {coach.title}
        </p>
      )}
      {coach.bio && (
        <p className="mt-4 font-sans text-sm leading-relaxed text-kca-gray-400">{coach.bio}</p>
      )}
    </div>
  );
}

export default function CoachesSection() {
  const [coaches, setCoaches] = useState<Coach[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    fetch("/api/public/site")
      .then((r) => r.json())
      .then((d) => setCoaches(d?.coaches ?? []))
      .catch(() => setCoaches([]))
      .finally(() => setLoaded(true));
  }, []);

  if (!loaded || coaches.length === 0) return null;

  // Only scroll once there is enough to scroll — below this the duplicate copy a marquee
  // needs for its seamless loop is plainly visible and reads as a bug. See the same rule
  // in AchievementsSection.
  const scrolling = coaches.length >= 4;
  // Seconds per card, so four coaches and forty travel at the same visual speed.
  const duration = `${Math.max(24, coaches.length * 7)}s`;

  return (
    <section id="coaches" className="relative overflow-hidden bg-[#050505] px-6 py-20 md:px-8">
      <div
        className="pointer-events-none absolute left-0 top-0 h-96 w-96"
        style={{ backgroundImage: "radial-gradient(circle, rgba(0, 200, 232, 0.05) 0%, transparent 70%)" }}
      />

      <div className="relative z-10">
        <div className="mx-auto mb-16 max-w-7xl text-center md:text-left">
          <h2 className="section-heading">Our Coaches</h2>
          <p className="section-subheading mt-4">The people who will be teaching your child.</p>
        </div>

        {/* One line. The list is rendered twice and the track slides exactly -50%, so the
            second copy arrives where the first began — a seamless loop with no JavaScript
            measuring anything. The duplicate is aria-hidden or every name is read twice. */}
        {scrolling ? (
          <div className="kca-marquee" style={{ "--kca-marquee-duration": duration } as React.CSSProperties}>
            <div className="kca-marquee-track gap-8 px-4 py-2">
              {[0, 1].map((copy) =>
                coaches.map((coach) => (
                  <CoachCard key={`${copy}-${coach.id}`} coach={coach} duplicate={copy === 1} />
                )),
              )}
            </div>
          </div>
        ) : (
          <div className="mx-auto flex max-w-7xl flex-wrap justify-center gap-8 px-4">
            {coaches.map((coach) => (
              <CoachCard key={coach.id} coach={coach} duplicate={false} />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
