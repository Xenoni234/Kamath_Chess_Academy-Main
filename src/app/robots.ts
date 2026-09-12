import type { MetadataRoute } from "next";

import { SITE_URL } from "@/lib/seo";

/**
 * Serves /robots.txt.
 *
 * Nothing was ever blocking crawlers — `proxy.ts` only gates `/dashboard/:path*` — but
 * with no robots.txt and no sitemap a new domain has almost no discovery surface, which
 * is why Google was still saying the academy "does not have a dedicated official website".
 *
 * `/dashboard` and `/api` are disallowed because they are private and useless in a search
 * result, not because they are secret: the authorisation checks are what protect them.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/dashboard/", "/api/"],
    },
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  };
}
