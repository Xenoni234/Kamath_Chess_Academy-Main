import type { Metadata } from "next";
import { Space_Grotesk, Inter, JetBrains_Mono } from "next/font/google";
import { ORGANISATION_JSON_LD, SITE_NAME, SITE_URL } from "@/lib/seo";
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

const DESCRIPTION =
  "Chess coaching in Mumbai for beginners to tournament players. Live classes with FIDE-rated coaches, plus engine analysis, puzzles and opening preparation you can use at home.";

export const metadata: Metadata = {
  /**
   * `metadataBase` has to exist before any relative URL below resolves — without it Next
   * cannot build an absolute og:image and drops it silently.
   */
  metadataBase: new URL(SITE_URL),
  title: {
    default: "Kamath Chess Academy (KCA) | Chess Coaching in Mumbai",
    /** Pages set only their own name; this appends the academy. */
    template: `%s | ${SITE_NAME}`,
  },
  description: DESCRIPTION,
  applicationName: SITE_NAME,
  /**
   * Caddy 301s www to the apex, but a canonical says so explicitly — otherwise any page
   * reachable at two hostnames is two competing documents as far as a crawler knows.
   */
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    siteName: SITE_NAME,
    title: "Kamath Chess Academy (KCA) | Chess Coaching in Mumbai",
    description: DESCRIPTION,
    url: SITE_URL,
    locale: "en_IN",
    images: [{ url: "/kca-logo.png", width: 512, height: 512, alt: SITE_NAME }],
  },
  twitter: {
    card: "summary",
    title: "Kamath Chess Academy (KCA) | Chess Coaching in Mumbai",
    description: DESCRIPTION,
    images: ["/kca-logo.png"],
  },
  robots: {
    index: true,
    follow: true,
    googleBot: { index: true, follow: true, "max-image-preview": "large", "max-snippet": -1 },
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      data-theme="dark"
      suppressHydrationWarning
      className={`${spaceGrotesk.variable} ${inter.variable} ${jetbrainsMono.variable} h-full antialiased scroll-smooth`}
    >
      <body className="min-h-full bg-kca-black text-kca-white font-sans selection:bg-kca-cyan/25 flex flex-col">
        {/* Who this organisation is, in the form search engines read. Lives here rather
            than on the public homepage so `src/app/(public)/` stays untouched. */}
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(ORGANISATION_JSON_LD) }}
        />
        {/* Apply the saved theme before paint to avoid a flash of the wrong theme. */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              "(function(){try{var t=localStorage.getItem('kca-theme');document.documentElement.setAttribute('data-theme',t==='light'?'light':'dark');}catch(e){}})();",
          }}
        />
        {children}
      </body>
    </html>
  );
}
