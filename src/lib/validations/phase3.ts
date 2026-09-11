import { z } from "zod";

/** Accepts ISO strings and `datetime-local` values (which omit seconds/zone). */
const dateString = z.string().refine((s) => !Number.isNaN(Date.parse(s)), { message: "Invalid date/time" });

export const createBatchSchema = z.object({
  name: z.string().min(2, "Name must be at least 2 characters").max(80),
  description: z.string().max(500).optional(),
  coachUserId: z.string().optional(),
});

export const assignCoachSchema = z.object({
  coachUserId: z.string().min(1, "Pick a coach"),
});

export const createClassSchema = z.object({
  batchId: z.string().min(1, "Pick a batch"),
  title: z.string().min(2, "Title must be at least 2 characters").max(120),
  description: z.string().max(500).optional(),
  coachUserId: z.string().optional(),
  startsAt: dateString,
  endsAt: dateString,
  meetingUrl: z.string().max(300).optional(),
});

/**
 * Editing an existing class. Every field optional — a reschedule sends two dates,
 * a cancellation sends a status, and neither should have to resend the title.
 *
 * `status` accepts only SCHEDULED and CANCELLED. ONGOING and COMPLETED are set by
 * actually starting and ending the room, and letting them be PATCHed would mean a
 * class could be marked "completed" without ever being taught — which is exactly
 * the number the head reads off the coach-activity table.
 */
export const updateClassSchema = z
  .object({
    title: z.string().min(2, "Title must be at least 2 characters").max(120).optional(),
    description: z.string().max(500).nullable().optional(),
    startsAt: dateString.optional(),
    endsAt: dateString.optional(),
    meetingUrl: z.string().max(300).nullable().optional(),
    status: z.enum(["SCHEDULED", "CANCELLED"]).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "Nothing to update" });

/**
 * Editing a batch. `coachUserId` is in the same schema as the name, but the route
 * refuses it for a coach — moving a batch between coaches is an academy decision,
 * not a teaching one, and a coach who could set it could hand their batch away or
 * take a colleague's.
 */
export const updateBatchSchema = z
  .object({
    name: z.string().min(2, "Name must be at least 2 characters").max(80).optional(),
    description: z.string().max(500).nullable().optional(),
    coachUserId: z.string().min(1).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "Nothing to update" });

/**
 * Enrol into a batch: an id (staff picked one from the list) or an exact username.
 *
 * The username path exists for coaches, who cannot read the academy-wide student
 * directory — `/api/users` is staff-only and stays that way. Exact match, never a
 * search: partial matches would let a coach enumerate the academy's students a
 * letter at a time. A coach who can name the student in front of them can add
 * them; nobody can go fishing.
 */
export const enrollSchema = z
  .object({
    studentUserId: z.string().min(1).optional(),
    username: z.string().trim().min(1).max(20).optional(),
  })
  .refine((v) => Boolean(v.studentUserId || v.username), { message: "Pick a student" });

export const createTournamentSchema = z.object({
  title: z.string().min(2, "Title must be at least 2 characters").max(120),
  description: z.string().max(500).optional(),
  type: z.enum(["ARENA", "SWISS", "ROUND_ROBIN"]),
  startsAt: dateString,
});
