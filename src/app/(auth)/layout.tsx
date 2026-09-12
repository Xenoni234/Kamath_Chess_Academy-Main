import type { Metadata } from "next";

/**
 * Titles for the sign-in routes.
 *
 * Every page under (auth) is a client component, so none of them can export metadata.
 * Without this layout all six — /login, the four role portals, /register and
 * /forgot-password — shipped the homepage's title verbatim, which is both useless in a
 * search result and confusing in a browser tab.
 *
 * `noindex` is deliberate: a sign-in form has nothing to offer someone arriving from a
 * search, and indexing it competes with the homepage for the academy's own name.
 */
export const metadata: Metadata = {
  title: "Sign in",
  description: "Sign in to your Kamath Chess Academy account.",
  robots: { index: false, follow: true },
};

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return children;
}
