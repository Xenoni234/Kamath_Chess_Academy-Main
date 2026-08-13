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

export const enrollSchema = z.object({
  studentUserId: z.string().min(1, "Pick a student"),
});
