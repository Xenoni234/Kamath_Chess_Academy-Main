import { z } from "zod";

/**
 * Consent and contact-inbox payloads.
 *
 * Note what is deliberately absent: there is no way to withdraw the three
 * MANDATORY consents (terms, age/guardian, data processing) through this schema.
 * Withdrawing consent to data processing is functionally an erasure request — the
 * account cannot continue to exist without it — so it routes through the contact
 * form and a staff-run anonymisation, not a toggle that would silently leave the
 * account working while claiming consent had been withdrawn.
 */
export const consentUpdateSchema = z
  .object({
    marketing: z.boolean().optional(),
    sms: z.boolean().optional(),
  })
  .refine((data) => data.marketing !== undefined || data.sms !== undefined, {
    message: "Nothing to update",
  });

export const contactQuerySchema = z.object({
  /** Defaults to the unhandled queue — the only view that is actually a to-do list. */
  handled: z.enum(["true", "false", "all"]).default("false"),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).optional(),
});

export const contactUpdateSchema = z.object({
  handled: z.boolean(),
});
