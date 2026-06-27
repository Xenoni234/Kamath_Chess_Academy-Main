"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { BarChart3, BookOpen, CalendarDays, CreditCard, HeartHandshake, Home, LogOut, Shield, Trophy, Users } from "lucide-react";
import { cn } from "@/lib/utils";

type NavItem = {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
};

const navByRole: Record<string, NavItem[]> = {
  STUDENT: [
    { href: "/dashboard/student", label: "Overview", icon: Home },
    { href: "/dashboard/student", label: "Games", icon: Trophy },
    { href: "/dashboard/student", label: "Puzzles", icon: BookOpen },
  ],
  PARENT: [
    { href: "/dashboard/parent", label: "Overview", icon: Home },
    { href: "/dashboard/parent", label: "Progress", icon: BarChart3 },
    { href: "/dashboard/parent", label: "Payments", icon: CreditCard },
  ],
  COACH: [
    { href: "/dashboard/coach", label: "Overview", icon: Home },
    { href: "/dashboard/coach", label: "Batches", icon: Users },
    { href: "/dashboard/coach", label: "Classes", icon: CalendarDays },
  ],
  HR: [
    { href: "/dashboard/hr", label: "Overview", icon: Home },
    { href: "/dashboard/hr", label: "Students", icon: Users },
    { href: "/dashboard/hr", label: "Operations", icon: HeartHandshake },
  ],
  HEAD: [
    { href: "/dashboard/head", label: "Overview", icon: Home },
    { href: "/dashboard/head", label: "Platform", icon: Shield },
    { href: "/dashboard/hr", label: "HR View", icon: HeartHandshake },
  ],
};

export default function DashboardSidebar({ username, role }: { username: string; role: string }) {
  const pathname = usePathname();
  const router = useRouter();
  const navItems = navByRole[role] ?? navByRole.STUDENT;

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  }

  return (
    <aside className="flex min-h-screen w-full flex-col border-r border-kca-border bg-kca-surface px-4 py-5 md:w-72">
      <Link href="/" className="mb-8 flex items-center gap-3 rounded-xl border border-kca-border bg-kca-black p-3">
        <Image src="/kca-logo.png" alt="KCA" width={44} height={44} className="h-11 w-11 object-contain" />
        <div>
          <div className="font-display text-sm font-bold text-kca-white">Kamath Chess Academy</div>
          <div className="mt-1 text-xs text-kca-gray-400">Training Platform</div>
        </div>
      </Link>

      <div className="mb-6 rounded-lg border border-kca-cyan/20 bg-kca-cyan/5 p-3">
        <div className="text-sm font-semibold text-kca-white">{username}</div>
        <div className="mt-2 inline-flex rounded-full border border-kca-cyan/30 px-3 py-1 font-display text-[11px] font-bold uppercase tracking-wider text-kca-cyan">
          {role}
        </div>
      </div>

      <nav className="space-y-2">
        {navItems.map((item) => {
          const Icon = item.icon;
          const active = pathname === item.href;

          return (
            <Link
              key={`${item.label}-${item.href}`}
              href={item.href}
              className={cn(
                "flex items-center gap-3 rounded-lg border-l-2 border-transparent px-4 py-3 text-sm font-semibold text-kca-gray-400 transition-all hover:bg-kca-surface-2 hover:text-kca-white",
                active && "border-kca-cyan bg-kca-surface-2 text-kca-white"
              )}
            >
              <Icon className="h-4 w-4 text-kca-cyan" />
              {item.label}
            </Link>
          );
        })}
      </nav>

      <button type="button" onClick={logout} className="btn-secondary mt-auto w-full">
        <LogOut className="h-5 w-5" />
        Logout
      </button>
    </aside>
  );
}
