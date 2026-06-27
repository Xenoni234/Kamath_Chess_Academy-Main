import HeroSection from "@/components/public/HeroSection";
import AchievementsSection from "@/components/public/AchievementsSection";
import TournamentSchedule from "@/components/public/TournamentSchedule";
import AboutSection from "@/components/public/AboutSection";
import ContactSection from "@/components/public/ContactSection";

export default function HomePage() {
  return (
    <>
      {/* 1. HERO SECTION (id="home" is inside the component) */}
      <HeroSection />

      {/* 2. ACHIEVEMENTS SECTION (id="achievements" is inside the component) */}
      <AchievementsSection />

      {/* 3. TOURNAMENT SCHEDULE SECTION (id="schedule" is inside the component) */}
      <TournamentSchedule />

      {/* 4. ABOUT US SECTION (id="about" is inside the component) */}
      <AboutSection />

      {/* 5. CONTACT SECTION (id="contact" is inside the component) */}
      <ContactSection />
    </>
  );
}
