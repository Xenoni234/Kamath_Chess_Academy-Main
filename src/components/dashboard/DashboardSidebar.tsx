"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { BookOpen, Home, LogOut, Swords, Trophy, Bot, Activity, Puzzle, Map, FileText } from "lucide-react";
import { cn } from "@/lib/utils";
import { getSocket } from "@/lib/socket/client";
import ThemeToggle from "@/components/ThemeToggle";

type NavItem = {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  /** If set, the item is shown only to these roles (uppercase). Absent = all. */
  roles?: string[];
};

export default function DashboardSidebar({ username, role }: { username: string; role: string }) {
  const pathname = usePathname();
  const router = useRouter();
  const [onlineCount, setOnlineCount] = useState(0);

  // Set up socket listener for online player count
  useEffect(() => {
    const socket = getSocket();

    socket.on("presence:online-count", (count: number) => {
      setOnlineCount(count);
    });

    return () => {
      socket.off("presence:online-count");
    };
  }, []);

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  }

  const roleLower = role.toLowerCase();

  // Define sidebar items in order:
  // Overview / Home -> Play -> Games -> Puzzles
  const navItems: NavItem[] = [
    { href: `/dashboard/${roleLower}`, label: "Overview", icon: Home },
    { href: "/dashboard/play", label: "Play vs Human", icon: Swords },
    { href: "/dashboard/play-engine", label: "Play Engine", icon: Bot },
    { href: "/dashboard/analysis", label: "Analysis", icon: Activity },
    { href: "/dashboard/puzzles", label: "Puzzles", icon: Puzzle },
    { href: "/dashboard/openings", label: "Openings", icon: Map },
    { href: "/dashboard/reports", label: "Reports", icon: FileText },
    { href: "/dashboard/games", label: "Games", icon: Trophy },
    // Phase 3 items are added here per track, each with a `roles` gate.
  ];

  const roleUpper = role.toUpperCase();
  const visibleItems = navItems.filter((item) => !item.roles || item.roles.includes(roleUpper));

  return (
    <aside className="flex min-h-screen w-full flex-col border-r border-kca-border bg-kca-surface px-4 py-5 md:w-72 select-none">
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
        {visibleItems.map((item) => {
          const Icon = item.icon;
          const active = pathname === item.href;

          return (
            <div key={`${item.label}-${item.href}`} className="flex flex-col">
              <Link
                href={item.href}
                className={cn(
                  "flex items-center gap-3 rounded-lg border-l-2 border-transparent px-4 py-3 text-sm font-semibold text-kca-gray-400 transition-all hover:bg-kca-surface-2 hover:text-kca-white",
                  active && "border-kca-cyan bg-kca-surface-2 text-kca-white"
                )}
              >
                <Icon className="h-4 w-4 text-kca-cyan" />
                {item.label}
              </Link>
              
              {/* Online Player count dot widget directly below Play link */}
              {item.label === "Play vs Human" && (
                <div className="ml-9 mt-0.5 mb-1 text-xs text-kca-success font-semibold flex items-center gap-1.5 animate-pulse">
                  <span className="h-1.5 w-1.5 rounded-full bg-kca-success" />
                  <span>{onlineCount} online</span>
                </div>
              )}
            </div>
          );
        })}
      </nav>

      <div className="mt-auto space-y-2 pt-4">
        <ThemeToggle />
        <button type="button" onClick={logout} className="btn-secondary w-full">
          <LogOut className="h-5 w-5" />
          Logout
        </button>
      </div>
    </aside>
  );
}
