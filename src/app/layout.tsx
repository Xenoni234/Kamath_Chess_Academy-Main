import type { Metadata } from "next";
import { Space_Grotesk, Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";

const spaceGrotesk = Space_Grotesk({
  variable: "--font-space-grotesk",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700"],
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains-mono",
  subsets: ["latin"],
  weight: ["400", "500", "700"],
});

export const metadata: Metadata = {
  title: "Kamath Chess Academy (KCA) | Premier Chess Coaching",
  description: "Lichess-powered platform with AI analysis, grandmaster-level preparation tools, and live coaching at India's premier chess academy.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`dark ${spaceGrotesk.variable} ${inter.variable} ${jetbrainsMono.variable} h-full antialiased scroll-smooth`}
      style={{ backgroundColor: "#050505" }}
    >
      <body className="min-h-full bg-kca-black text-kca-white font-sans selection:bg-kca-cyan/25 flex flex-col">
        {children}
      </body>
    </html>
  );
}
