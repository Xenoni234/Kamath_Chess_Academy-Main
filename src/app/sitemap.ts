import type { MetadataRoute } from "next";

import { SITE_URL } from "@/lib/seo";

/**
 * Serves /sitemap.xml — every page a stranger can actually reach.
 *
 * Only public routes belong here. Dashboard pages are behind a login, so listing them
 * would just produce a sitemap full of redirects to /login.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const updated = new Date();

  return [
    { url: SITE_URL, lastModified: updated, changeFrequency: "weekly", priority: 1 },
    { url: `${SITE_URL}/register`, lastModified: updated, changeFrequency: "monthly", priority: 0.8 },
    { url: `${SITE_URL}/login`, lastModified: updated, changeFrequency: "monthly", priority: 0.5 },
    { url: `${SITE_URL}/privacy`, lastModified: updated, changeFrequency: "yearly", priority: 0.3 },
    { url: `${SITE_URL}/terms`, lastModified: updated, changeFrequency: "yearly", priority: 0.3 },
    { url: `${SITE_URL}/refund`, lastModified: updated, changeFrequency: "yearly", priority: 0.3 },
  ];
}
