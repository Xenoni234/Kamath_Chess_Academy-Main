import type { Role } from "@prisma/client";

/**
 * Login portals.
 *
 * Separate branded entrances per audience. A portal is PRESENTATION ONLY — the
 * account's own role decides what it can reach. Signing in through the wrong
 * portal is a wrong turn, not an escalation: the user is sent to their real
 * dashboard with an explanation, never granted the portal's scope.
 */
export type PortalKey = "student" | "parent" | "coach" | "staff";

export type Portal = {
  key: PortalKey;
  title: string;
  subtitle: string;
  /** Roles that belong to this entrance. */
  roles: Role[];
  /** Shown on the picker. */
  blurb: string;
};

export const PORTALS: Record<PortalKey, Portal> = {
  student: {
    key: "student",
    title: "Student Sign In",
    subtitle: "Train, play and review your games.",
    roles: ["STUDENT"],
    blurb: "Play, solve puzzles, analyse games and study openings.",
  },
  parent: {
    key: "parent",
    title: "Parent Sign In",
    subtitle: "Follow your child's progress.",
    roles: ["PARENT"],
    blurb: "See your child's classes, attendance, reports and fees.",
  },
  coach: {
    key: "coach",
    title: "Coach Sign In",
    subtitle: "Run your classes and batches.",
    roles: ["COACH"],
    blurb: "Your roster, live classes, attendance and student progress.",
  },
  staff: {
    key: "staff",
    title: "Staff Sign In",
    subtitle: "Academy administration.",
    roles: ["HR", "HEAD"],
    blurb: "Admissions, scheduling, fees and academy management.",
  },
};

export const PORTAL_KEYS = Object.keys(PORTALS) as PortalKey[];

/** Where a role lands after signing in. */
export const DASHBOARD_FOR_ROLE: Record<Role, string> = {
  STUDENT: "/dashboard/student",
  PARENT: "/dashboard/parent",
  COACH: "/dashboard/coach",
  HR: "/dashboard/hr",
  HEAD: "/dashboard/head",
};

/** The portal a given role should have used. */
export function portalForRole(role: Role): Portal {
  return PORTALS[PORTAL_KEYS.find((k) => PORTALS[k].roles.includes(role)) ?? "student"];
}
