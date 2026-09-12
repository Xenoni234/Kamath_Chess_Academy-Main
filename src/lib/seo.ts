/**
 * One place for the canonical origin.
 *
 * Caddy 301s www to the apex, so the apex is the only address that should ever appear in
 * a canonical tag, a sitemap or an OG URL. Hardcoded rather than read from
 * NEXT_PUBLIC_APP_URL because a wrong or missing value here does not fail loudly — it
 * quietly publishes the wrong address to every crawler.
 */
export const SITE_URL = "https://kamathchessacademy.com";

export const SITE_NAME = "Kamath Chess Academy";

/**
 * Organisation details for JSON-LD, taken from the footer so there is one source of truth
 * for name/address/phone.
 *
 * Deliberately claims nothing about who the academy's students are. The homepage lists
 * several well-known titled players as "our elite academy students"; until that is
 * confirmed, structured data must not repeat it — search engines treat schema as an
 * assertion by the site owner, and an unfounded one is worse than none.
 */
export const ORGANISATION_JSON_LD = {
  "@context": "https://schema.org",
  "@type": "EducationalOrganization",
  name: SITE_NAME,
  alternateName: "KCA",
  url: SITE_URL,
  logo: `${SITE_URL}/kca-logo.png`,
  email: "kamathchessacademy@gmail.com",
  telephone: "+91 73874 65229",
  address: {
    "@type": "PostalAddress",
    addressLocality: "Mumbai",
    addressRegion: "Maharashtra",
    addressCountry: "IN",
  },
  sameAs: ["https://www.instagram.com/kamath_chess/"],
} as const;
