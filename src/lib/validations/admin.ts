import { z } from "zod";

/**
 * Staff administration payloads.
 *
 * Role is set here and nowhere else: public registration always creates a
 * STUDENT, so this is the only path by which a privileged account can exist.
 */

export const ROLES = ["STUDENT", "PARENT", "COACH", "HR", "HEAD"] as const;

/** Roles HR may create. Creating or promoting staff is HEAD-only. */
export const HR_CREATABLE_ROLES = ["STUDENT", "PARENT", "COACH"] as const;

export const createUserSchema = z.object({
  username: z
    .string()
    .trim()
    .min(3, "Username is at least 3 characters")
    .max(20)
    .regex(/^[a-zA-Z0-9_-]+$/, "Letters, numbers, _ and - only"),
  email: z.string().email().transform((v) => v.toLowerCase()),
  mobile: z.string().trim().min(10, "Enter a valid mobile number").max(15),
  role: z.enum(ROLES),
  /** Optional: link this new PARENT to children immediately. */
  childIds: z.array(z.string().min(1)).max(10).optional(),
});

export const updateUserSchema = z
  .object({
    role: z.enum(ROLES).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((v) => v.role !== undefined || v.isActive !== undefined, {
    message: "Nothing to update",
  });

export const userQuerySchema = z.object({
  role: z.enum(ROLES).optional(),
  q: z.string().trim().max(60).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const parentLinkSchema = z.object({
  parentId: z.string().min(1),
  studentId: z.string().min(1),
});

/** Mark attendance for a class, in one batch of rows. */
export const attendanceMarkSchema = z.object({
  classId: z.string().min(1),
  entries: z
    .array(
      z.object({
        userId: z.string().min(1),
        status: z.enum(["PRESENT", "ABSENT", "LATE", "EXCUSED"]),
        note: z.string().trim().max(200).optional(),
      }),
    )
    .min(1)
    .max(200),
});

/** Record an offline payment (cash / UPI / bank transfer). */
export const paymentCreateSchema = z.object({
  userId: z.string().min(1),
  /** Rupees. Two decimals; the column is Decimal(10,2). */
  amount: z.coerce.number().positive().max(10_000_000),
  status: z.enum(["PENDING", "COMPLETED"]).default("COMPLETED"),
  method: z.enum(["CASH", "UPI", "BANK", "CARD", "OTHER"]).optional(),
  description: z.string().trim().max(200).optional(),
  note: z.string().trim().max(500).optional(),
  dueDate: z.coerce.date().optional(),
});

export const paymentUpdateSchema = z.object({
  status: z.enum(["PENDING", "COMPLETED", "FAILED", "REFUNDED"]),
  method: z.enum(["CASH", "UPI", "BANK", "CARD", "OTHER"]).optional(),
  note: z.string().trim().max(500).optional(),
});

export const paymentQuerySchema = z.object({
  userId: z.string().min(1).optional(),
  status: z.enum(["PENDING", "COMPLETED", "FAILED", "REFUNDED"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});
