import { z } from "zod";


/**
 * What registration offers in its "I am a" dropdown.
 *
 * All four are selectable, but they are not equal:
 *
 *  - STUDENT and PARENT are granted on the spot. A parent is harmless on its own
 *    — they see a child only once staff link them through ParentStudent.
 *  - COACH and HR are *requests*. Granting them from a public form would hand any
 *    visitor the student roster, attendance and fee records. So the account is
 *    created as a DEACTIVATED student with `requestedRole` recorded, and staff
 *    approve it in the admin console. Login filters on `isActive`, so nothing is
 *    reachable until they do.
 *
 * HEAD is deliberately absent: it is the academy owner, it comes from
 * scripts/createHeadUser.ts, and it should never appear in a public dropdown.
 */
export const SIGNUP_ROLE_OPTIONS = ["STUDENT", "PARENT", "COACH", "HR"] as const;

/**
 * Roles granted on sign-up with nothing but the form.
 *
 * STUDENT and PARENT. The other two options in the dropdown — COACH and HR —
 * additionally require a single-use invite code issued by the academy head
 * (see lib/inviteCodes.ts). Without that, a public form would hand any visitor
 * the student roster, attendance and fee records.
 */
export const SELF_SIGNUP_ROLES = ["STUDENT", "PARENT"] as const;

/** Roles that additionally require an invite code. The rest of SIGNUP_ROLE_OPTIONS. */
export const CODE_REQUIRED_ROLES = ["COACH", "HR"] as const;

export const registerSchema = z.object({
  username: z.string().min(3).max(20),
  email: z.string().email(),
  mobile: z.string().min(10).max(15),
  password: z.string().min(8),
  confirmPassword: z.string(),
  fideId: z.string().optional().or(z.literal('')),
  lichessId: z.string().optional().or(z.literal('')),
  chesscomId: z.string().optional().or(z.literal('')),
  otp: z.string().length(6),
  role: z.enum(SIGNUP_ROLE_OPTIONS).default("STUDENT"),
  /** Required for COACH and HR; the route enforces that, since it depends on `role`. */
  inviteCode: z.string().trim().max(40).optional().or(z.literal("")),
  /** Required for PARENT — the student they are a parent of, and that student's code. */
  studentUsername: z.string().trim().max(20).optional().or(z.literal("")),
  parentCode: z.string().trim().max(20).optional().or(z.literal("")),
  agreedToTerms: z.boolean(),
  agreedToAge: z.boolean(),
  agreedToDataProcessing: z.boolean(),
  agreedToMarketing: z.boolean().optional().default(false),
  agreedToSms: z.boolean().optional().default(false),
}).refine(data => data.password === data.confirmPassword, {
  message: 'Passwords do not match',
  path: ['confirmPassword']
}).refine(data => data.agreedToTerms && data.agreedToAge && 
          data.agreedToDataProcessing, {
  message: 'Required consents must be accepted'
});

export const loginSchema = z.object({
  identifier: z.string().min(3, "Enter your email or username"),
  password: z.string().min(1, "Password is required"),
});

export const contactSchema = z.object({
  name: z.string().min(2),
  email: z.string().email(),
  mobile: z.string().min(10).max(30),
  message: z.string().min(10),
});
