/**
 * Human labels for the action strings in `AuditLog.action`.
 *
 * The vocabulary grew organically and is in two styles: sixteen dotted lowercase
 * actions written through `writeAuditLog`, and four SCREAMING_SNAKE ones, two of
 * which bypass the helper entirely (`login/route.ts` and `register/route.ts`
 * write `db.auditLog.create` directly).
 *
 * **The strings are deliberately not being renamed.** They are already in rows
 * going back to the start of the project, and normalising them would either
 * orphan that history or require a migration that rewrites audit records — which
 * is precisely the thing an audit log must never do. So the inconsistency is
 * mapped here, at the point of display, and the stored values stay exactly as
 * they were written.
 *
 * Anything not listed falls back to the raw string: a new action should show up
 * in the viewer as itself rather than vanish.
 */
export const AUDIT_ACTION_LABELS: Record<string, string> = {
  // Accounts and access
  USER_REGISTERED: "Account created",
  USER_LOGGED_IN: "Signed in",
  "auth.password.reset": "Password reset",
  "consent.update": "Consent changed",
  "user.anonymise": "Account erased (DPDPA)",
  "admin.user.create": "Staff created an account",
  "admin.user.update": "Account role or status changed",
  "admin.parentLink.create": "Parent linked to child",
  "admin.parentLink.delete": "Parent unlinked from child",

  // Viewing someone else's data
  "student.overview.view": "Viewed a student's record",
  PARENT_VIEW_DASHBOARD: "Parent viewed their child's dashboard",
  PARENT_VIEW_CHILD_SCHEDULE: "Parent viewed their child's schedule",
  "contact.list": "Read the enquiry inbox",
  "contact.handle": "Marked an enquiry handled",
  "audit.read": "Read the audit log",

  // Academy operations
  "attendance.mark": "Attendance marked",
  "class.room.start": "Class started",
  "class.room.end": "Class ended",

  // Money
  "payment.record": "Payment recorded",
  "payment.update": "Payment status changed",
  "payment.order.create": "Payment order opened",
  "payment.settled": "Payment settled by gateway",
  "invoice.download": "Invoice downloaded",

  // AI features
  "second.profile.create": "Opponent dossier requested",
  "second.profile.delete": "Opponent dossier deleted",
  "second.profile.regenerate": "Opponent dossier regenerated",
  "opening.generate": "Opening repertoire built",
  "opening.regenerate": "Opening repertoire rebuilt",
  "game.view": "Viewed a student's game",
};

export function auditActionLabel(action: string): string {
  return AUDIT_ACTION_LABELS[action] ?? action;
}
