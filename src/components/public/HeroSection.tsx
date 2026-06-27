import { ArrowRight, Sparkles } from "lucide-react";

export default function HeroSection() {
  const stats = [
    { value: "500+", label: "Students" },
    { value: "50+", label: "Coaches" },
    { value: "10,000+", label: "Games Played" },
    { value: "15+", label: "Tournaments" },
  ];

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
        {/* Eyebrow */}
        <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-kca-cyan/20 bg-kca-cyan/5 px-4 py-1.5">
          <Sparkles className="h-4 w-4 text-kca-cyan" />
          <span className="font-display text-xs font-bold uppercase tracking-widest text-kca-cyan">
            India&apos;s Premier Chess Academy
          </span>
        </div>

        {/* Main Heading */}
        <h1 className="font-display text-5xl font-black leading-none text-kca-white sm:text-6xl md:text-7xl lg:text-8xl tracking-tight">
          Master the Game. <br className="hidden sm:inline" />
          <span className="bg-gradient-to-r from-kca-cyan to-kca-cyan-bright bg-clip-text text-transparent drop-shadow-[0_0_30px_rgba(0,200,232,0.2)]">
            Master Your Mind.
          </span>
        </h1>

        {/* Subheading */}
        <p className="mt-8 max-w-2xl font-sans text-base leading-relaxed text-kca-gray-400 sm:text-lg md:text-xl">
          Lichess-powered platform with AI analysis, grandmaster-level
          preparation tools, and live coaching. Elevate your play from amateur
          to champion.
        </p>

        {/* Action Buttons */}
        <div className="mt-10 flex flex-col items-center justify-center gap-4 sm:flex-row w-full sm:w-auto">
          <a href="#contact" className="btn-primary w-full sm:w-auto text-center px-8 py-4">
            Get Started
            <ArrowRight className="h-5 w-5" />
          </a>
          <a href="#about" className="btn-secondary w-full sm:w-auto text-center px-8 py-4">
            Explore Platform
          </a>
        </div>
      </div>

      {/* Stats Row */}
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
    </section>
  );
}
