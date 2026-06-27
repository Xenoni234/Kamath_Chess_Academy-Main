import { Trophy } from "lucide-react";

interface Achievement {
  name: string;
  achievement: string;
  date: string;
}

export default function AchievementsSection() {
  const achievements: Achievement[] = [
    {
      name: "Aditya Mittal",
      achievement: "Achieved 3rd Grandmaster norm at Belgrade Open 2026.",
      date: "May 2026",
    },
    {
      name: "Pranav V",
      achievement: "Secured International Master title at Dubai Chess Classic.",
      date: "April 2026",
    },
    {
      name: "Savitha Shri B",
      achievement: "Won Silver Medal at World Youth Chess Championship.",
      date: "December 2025",
    },
    {
      name: "Nihal Sarin",
      achievement: "Reached Semifinals at Speed Chess Championship.",
      date: "January 2026",
    },
    {
      name: "Divya Deshmukh",
      achievement: "Won Gold at Asian Continental Women Championship.",
      date: "March 2026",
    },
    {
      name: "Leon Mendonca",
      achievement: "Won Wijk aan Zee Challengers Tournament.",
      date: "February 2026",
    },
  ];

  return (
    <section id="achievements" className="bg-[#0D0D0D] py-20 px-6 md:px-8 relative overflow-hidden">
      {/* Background Accent Glow */}
      <div 
        className="absolute bottom-0 right-0 w-96 h-96 pointer-events-none"
        style={{
          backgroundImage: "radial-gradient(circle, rgba(0, 200, 232, 0.05) 0%, transparent 70%)",
        }}
      />

      <div className="mx-auto max-w-7xl relative z-10">
        {/* Section Headers */}
        <div className="mb-16 text-center md:text-left">
          <h2 className="section-heading">Our Champions</h2>
          <p className="section-subheading mt-4">
            Celebrating the milestones, victories, and grandmaster breakthroughs of our elite academy students.
          </p>
        </div>

        {/* 3-Column Card Grid */}
        <div className="grid grid-cols-1 gap-8 sm:grid-cols-2 lg:grid-cols-3">
          {achievements.map((item, index) => (
            <div
              key={index}
              className="card flex flex-col justify-between hover:scale-[1.03]"
            >
              <div>
                {/* Trophy Icon */}
                <div className="mb-6 flex h-12 w-12 items-center justify-center rounded-lg bg-kca-cyan/10 border border-kca-cyan/20">
                  <Trophy className="h-6 w-6 text-kca-cyan" />
                </div>

                {/* Name */}
                <h3 className="font-display text-xl font-bold text-kca-white mb-2">
                  {item.name}
                </h3>

                {/* Achievement Description */}
                <p className="font-sans text-sm text-kca-gray-400 leading-relaxed mb-6">
                  {item.achievement}
                </p>
              </div>

              {/* Date */}
              <div className="font-display text-xs font-semibold uppercase tracking-wider text-kca-cyan">
                {item.date}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
