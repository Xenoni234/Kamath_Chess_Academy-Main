import { Suspense } from "react";
import { notFound } from "next/navigation";
import { PORTALS, PORTAL_KEYS, type PortalKey } from "@/lib/portals";
import LoginForm from "@/components/auth/LoginForm";

export function generateStaticParams() {
  return PORTAL_KEYS.map((portal) => ({ portal }));
}

/** A branded entrance per audience. The account's role still decides access —
 *  see LoginForm, which redirects a mismatched role to its own portal. */
export default async function PortalLoginPage({ params }: { params: Promise<{ portal: string }> }) {
  const { portal } = await params;
  if (!PORTAL_KEYS.includes(portal as PortalKey)) notFound();
  return (
    <Suspense fallback={null}>
      <LoginForm portal={PORTALS[portal as PortalKey]} />
    </Suspense>
  );
}
