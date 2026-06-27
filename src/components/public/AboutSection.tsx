import { CheckCircle2 } from "lucide-react";

export default function AboutSection() {
  const features = [
    "Lichess-style live multiplayer",
    "AI-powered opening preparation",
    "Digital Second opponent analysis",
    "Inbuilt video classes",
    "Structured tournaments",
    "Progress tracking for parents",
  ];

  return (
    <section id="about" className="bg-[#050505] py-20 px-6 md:px-8 relative overflow-hidden">
      <div className="mx-auto max-w-7xl relative z-10">
        <div className="grid grid-cols-1 gap-12 lg:grid-cols-2 lg:gap-20 items-center">
          
          {/* Left Column: About Kamath Chess Academy */}
          <div>
            <h2 className="section-heading">About Kamath Chess Academy</h2>
            
            <div className="mt-8 space-y-6 font-sans text-base leading-relaxed text-kca-gray-400">
              <p>
                Founded by Grandmaster mentors, Kamath Chess Academy (KCA) represents a paradigm shift in modern chess training. We combine the time-tested methodologies of classical Soviet chess preparation with a cutting-edge, proprietary digital platform to forge the next generation of competitive minds.
              </p>
              <p>
                Whether you are a novice learning the rules or an advanced tournament player seeking international norms, KCA provides an ecosystem designed for rapid growth. Our platform integrates seamlessly with Lichess, offering real-time live match analysis, grandmaster-curated database training, and direct mentorship from titled coaches.
              </p>
            </div>
          </div>

          {/* Right Column: Platform Features */}
          <div className="bg-kca-surface border border-kca-border p-8 md:p-10 rounded-2xl relative">
            {/* Background decorative glow */}
            <div 
              className="absolute top-0 right-0 w-64 h-64 pointer-events-none"
              style={{
                backgroundImage: "radial-gradient(circle, rgba(0, 200, 232, 0.03) 0%, transparent 70%)",
              }}
            />

            <h3 className="font-display text-2xl font-bold text-kca-white mb-6">
              Our Digital Learning Platform
            </h3>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
              {features.map((feature, index) => (
                <div key={index} className="flex items-start gap-3">
                  <CheckCircle2 className="h-5 w-5 text-kca-cyan flex-shrink-0 mt-0.5" />
                  <span className="font-sans text-sm md:text-base text-kca-gray-100 font-medium">
                    {feature}
                  </span>
                </div>
              ))}
            </div>
          </div>

        </div>
      </div>
    </section>
  );
}
