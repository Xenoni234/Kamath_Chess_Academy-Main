"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  Activity,
  Bot,
  Brain,
  CalendarDays,
  CalendarPlus,
  FileText,
  GraduationCap,
  History,
  Home,
  Inbox,
  IndianRupee,
  KeyRound,
  LogOut,
  Map,
  Medal,
  Menu,
  Puzzle,
  Swords,
  Trophy,
  UserCog,
  UserRound,
  Users,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { getSocket } from "@/lib/socket/client";
import ThemeToggle from "@/components/ThemeToggle";
import NotificationBell from "@/components/dashboard/NotificationBell";

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
  // Below `md` the sidebar is an off-canvas drawer. It used to be `w-full
  // min-h-screen` in normal flow, so on a phone every dashboard page opened
  // with a full screen of navigation and the actual page began below it.
  const [navOpen, setNavOpen] = useState(false);

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

  // While the drawer is open the page behind it must not scroll — otherwise a
  // swipe on the drawer scrolls the dashboard underneath and the user loses
  // their place.
  useEffect(() => {
    if (!navOpen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [navOpen]);

  // Escape closes it, for anyone on a tablet with a keyboard.
  useEffect(() => {
    if (!navOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setNavOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navOpen]);

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  }

  const roleLower = role.toLowerCase();

  // Define sidebar items in order:
  // Overview / Home -> Play -> Games -> Puzzles
  // Every item declares its roles. Previously only 3 of 13 did, so a parent was
  // shown a rated-game lobby and a puzzle trainer, and HR saw "Play vs Human" —
  // the nav described a student product regardless of who was signed in.
  const navItems: NavItem[] = [
    // Above Overview and with no `roles`, so every role has it. Everybody has a password
    // and, before this, nobody had a way to change it without asking staff.
    { href: "/dashboard/profile", label: "My Profile", icon: UserRound },
    { href: `/dashboard/${roleLower}`, label: "Overview", icon: Home },

    // --- Training (students; coaches keep it to demonstrate and prepare) ---
    { href: "/dashboard/play", label: "Play vs Human", icon: Swords, roles: ["STUDENT", "COACH", "HEAD"] },
    { href: "/dashboard/play-engine", label: "Play Engine", icon: Bot, roles: ["STUDENT", "COACH", "HEAD"] },
    { href: "/dashboard/analysis", label: "Analysis", icon: Activity, roles: ["STUDENT", "COACH", "HEAD"] },
    { href: "/dashboard/puzzles", label: "Puzzles", icon: Puzzle, roles: ["STUDENT", "COACH", "HEAD"] },
    { href: "/dashboard/openings", label: "Openings", icon: Map, roles: ["STUDENT", "COACH", "HEAD"] },
    { href: "/dashboard/opening", label: "Opening Trainer", icon: GraduationCap, roles: ["STUDENT", "COACH", "HEAD"] },
    { href: "/dashboard/second", label: "Second AI", icon: Brain, roles: ["STUDENT", "COACH", "HEAD"] },
    { href: "/dashboard/games", label: "Games", icon: Trophy, roles: ["STUDENT", "COACH", "HEAD"] },
    { href: "/dashboard/reports", label: "Reports", icon: FileText, roles: ["STUDENT", "COACH", "HEAD"] },
    { href: "/dashboard/tournaments", label: "Tournaments", icon: Medal, roles: ["STUDENT", "COACH", "HR", "HEAD"] },

    // --- Parent ---
    { href: "/dashboard/children", label: "My Children", icon: Users, roles: ["PARENT"] },

    // --- Coach, and the head, who also coaches ---
    //
    // The head runs the academy AND teaches, so every training tool a coach has
    // is listed for them too. The pages themselves already permitted it — only
    // this navigation hid them, which made the head's own product invisible to
    // the head.
    { href: "/dashboard/roster", label: "Students", icon: Users, roles: ["COACH", "HR", "HEAD"] },

    // --- Everyone who attends or runs a class ---
    { href: "/dashboard/classes", label: "Classes", icon: CalendarDays },

    // --- Students and their families ---
    { href: "/dashboard/fees", label: "Fees", icon: IndianRupee, roles: ["STUDENT", "PARENT"] },

    // --- Academy administration ---
    { href: "/dashboard/schedule", label: "Schedule", icon: CalendarPlus, roles: ["COACH", "HR", "HEAD"] },
    { href: "/dashboard/admin/users", label: "People", icon: UserCog, roles: ["HR", "HEAD"] },
    { href: "/dashboard/admin/payments", label: "Fees", icon: IndianRupee, roles: ["HEAD"] },
    { href: "/dashboard/admin/contact", label: "Enquiries", icon: Inbox, roles: ["HR", "HEAD"] },
    { href: "/dashboard/admin/invite-codes", label: "Invite codes", icon: KeyRound, roles: ["HEAD"] },
    { href: "/dashboard/admin/audit", label: "Audit log", icon: History, roles: ["HEAD"] },
  ];

  const roleUpper = role.toUpperCase();
  const visibleItems = navItems.filter((item) => !item.roles || item.roles.includes(roleUpper));

  // The shell in (dashboard)/layout.tsx is `md:h-screen md:overflow-hidden`, so
  // from `md` up this sidebar is exactly one viewport tall and the page cannot
  // scroll it — <main> owns the scrolling. No `sticky` involved.
  //
  // `overflow-hidden` here plus `flex-1 overflow-y-auto` on <nav> below means
  // that if the nav list is ever taller than the viewport, only that list
  // scrolls: the logo, user card, theme toggle and logout stay put.
  //
  // Below `md` the layout stacks vertically and this sits in normal flow.
  return (
    <>
      {/* Mobile-only top bar. It stays in normal flow (sticky, not fixed) so
          the page content begins immediately under it rather than behind it.
          Deliberately NO backdrop-blur: a filtered ancestor becomes the
          containing block for `position: fixed` descendants, which is exactly
          what broke the public navbar's overlay. */}
      <header className="sticky top-0 z-30 flex items-center gap-3 border-b border-kca-border bg-kca-surface px-4 py-3 md:hidden">
        <button
          type="button"
          onClick={() => setNavOpen(true)}
          aria-label="Open navigation"
          aria-expanded={navOpen}
          aria-controls="dashboard-nav"
          className="rounded-lg border border-kca-border p-2 text-kca-gray-400 hover:border-kca-cyan hover:text-kca-cyan"
        >
          <Menu className="h-5 w-5" />
        </button>
        <Link href={`/dashboard/${roleLower}`} className="flex min-w-0 items-center gap-2">
          <Image src="/kca-logo.png" alt="KCA" width={28} height={28} className="h-7 w-7 shrink-0 object-contain" />
          <span className="truncate font-display text-sm font-bold text-kca-white">Kamath Chess Academy</span>
        </Link>
      </header>

      {/* Dismiss layer. Rendered only when open so it never eats taps. */}
      {navOpen && (
        <div
          onClick={() => setNavOpen(false)}
          aria-hidden
          className="fixed inset-0 z-40 bg-kca-black/70 md:hidden"
        />
      )}

      <aside
        id="dashboard-nav"
        className={cn(
          // Mobile: an off-canvas drawer, sized to the phone and scrollable on
          // its own. `h-dvh` rather than `h-screen` so the iOS browser chrome
          // does not push the logout button below the fold.
          "fixed inset-y-0 left-0 z-50 flex h-dvh w-[17rem] max-w-[85vw] flex-col overflow-y-auto",
          "border-r border-kca-border bg-kca-surface px-4 py-5 select-none",
          "transition-transform duration-200 ease-out",
          navOpen ? "translate-x-0" : "-translate-x-full",
          // From `md` up it is the static app-shell column it always was.
          "md:static md:z-auto md:h-screen md:w-72 md:max-w-none md:translate-x-0 md:overflow-hidden md:transition-none",
        )}
      >
        {/* Only reachable on mobile; the drawer has no other close affordance
            for someone who does not want to navigate anywhere. */}
        <button
          type="button"
          onClick={() => setNavOpen(false)}
          aria-label="Close navigation"
          className="mb-3 self-end rounded-lg border border-kca-border p-2 text-kca-gray-400 hover:border-kca-cyan hover:text-kca-cyan md:hidden"
        >
          <X className="h-5 w-5" />
        </button>
      {/* Home for a signed-in person is their own dashboard, not the marketing
          site. Clicking the logo used to drop them onto the public homepage,
          which reads as having been signed out. The public navbar's logo still
          points at "/" — that is home when you are not signed in. */}
      <Link
        href={`/dashboard/${roleLower}`}
        onClick={() => setNavOpen(false)}
        className="mb-8 flex items-center gap-3 rounded-xl border border-kca-border bg-kca-black p-3"
      >
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

      <div className="mb-4">
        <NotificationBell />
      </div>

      {/* `min-h-0` is required — a flex child's default `min-height: auto`
          refuses to shrink below its content, so without it the nav would push
          the footer out of the aside instead of scrolling. */}
      <nav className="space-y-2 md:min-h-0 md:flex-1 md:overflow-y-auto">
        {visibleItems.map((item) => {
          const Icon = item.icon;
          const active = pathname === item.href;

          return (
            <div key={`${item.label}-${item.href}`} className="flex flex-col">
              <Link
                href={item.href}
                onClick={() => setNavOpen(false)}
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
    </>
  );
}
