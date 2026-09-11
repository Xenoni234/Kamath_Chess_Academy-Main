import { Suspense } from "react";
import Link from "next/link";
import { GraduationCap, Users, Trophy, Building2 } from "lucide-react";
import LoginForm from "@/components/auth/LoginForm";
import { PORTALS, PORTAL_KEYS } from "@/lib/portals";

const ICONS = {
  student: GraduationCap,
  parent: Users,
  coach: Trophy,
  staff: Building2,
} as const;

/**
 * The entrance hall: pick a portal, or just sign in.
 *
 * The generic form stays on this page because every unauthenticated redirect in
 * the app points at `/login` — turning that into a picker-only page would put an
 * extra click in front of a session that merely expired.
 */
export default function LoginPage() {
  return (
    <div className="space-y-8">
      <div>
        <p className="mb-3 text-center font-display text-xs font-semibold uppercase tracking-wider text-kca-gray-400">
          Choose your entrance
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          {PORTAL_KEYS.map((key) => {
            const portal = PORTALS[key];
            const Icon = ICONS[key];
            return (
              <Link
                key={key}
                href={`/login/${key}`}
                className="card flex items-start gap-3 border border-kca-border p-4 transition hover:border-kca-cyan"
              >
                <Icon className="mt-0.5 h-5 w-5 shrink-0 text-kca-cyan" />
                <span className="min-w-0">
                  <span className="block font-medium text-kca-white">
                    {portal.title.replace(" Sign In", "")}
                  </span>
                  <span className="block text-xs leading-snug text-kca-gray-400">{portal.blurb}</span>
                </span>
              </Link>
            );
          })}
        </div>
      </div>

      <div className="relative">
        <div className="absolute inset-0 flex items-center">
          <span className="w-full border-t border-kca-border" />
        </div>
        <div className="relative flex justify-center">
          <span className="bg-kca-black px-3 text-xs uppercase tracking-wider text-kca-gray-500">
            or sign in directly
          </span>
        </div>
      </div>

      <Suspense fallback={<p className="text-center text-sm text-kca-gray-400">Loading…</p>}>
        <LoginForm />
      </Suspense>
    </div>
  );
}
