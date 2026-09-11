/**
 * Invoice numbering.
 *
 * `Invoice.number` is `@unique`, so two invoices created at the same instant must
 * not be able to pick the same number. The obvious implementation — count the
 * existing invoices and add one — is a race: under Postgres' default READ
 * COMMITTED isolation, two concurrent transactions both read N and both try to
 * write N+1, and one dies on the unique index. SERIALIZABLE would close the race
 * but turns every invoice into a retry-on-40001 loop.
 *
 * Instead there is a counter row per financial year, incremented with a single
 * atomic `INSERT ... ON CONFLICT DO UPDATE SET seq = seq + 1 RETURNING seq`.
 * Postgres serialises the conflicting updates on the row lock itself, so the
 * reservation is race-free in one round trip with no retry logic and no
 * isolation-level surprises.
 *
 * **Numbers can have gaps.** If the caller fails after reserving one, that number
 * is spent. That is the correct behaviour for an invoice sequence — a reserved
 * number must never be reused — and is normal accounting practice.
 *
 * India's financial year runs April to March, so the label is "2026-27".
 */
import { db } from "@/lib/db";

/** "2026-27" for any date between 1 Apr 2026 and 31 Mar 2027. */
export function financialYear(date: Date = new Date()): string {
  const year = date.getUTCFullYear();
  // getUTCMonth() is 0-based, so March is 2 and April is 3.
  const startYear = date.getUTCMonth() >= 3 ? year : year - 1;
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}`;
}

/**
 * Reserve the next invoice number for the current financial year.
 * Safe to call concurrently; every caller gets a distinct number.
 */
export async function reserveInvoiceNumber(now: Date = new Date()): Promise<string> {
  const fy = financialYear(now);

  const rows = await db.$queryRaw<Array<{ seq: number }>>`
    INSERT INTO invoice_counters (fy, seq, "updatedAt")
    VALUES (${fy}, 1, now())
    ON CONFLICT (fy) DO UPDATE SET seq = invoice_counters.seq + 1, "updatedAt" = now()
    RETURNING seq
  `;

  const seq = rows[0]?.seq;
  if (typeof seq !== "number") {
    throw new Error("invoice counter did not return a sequence");
  }

  return `KCA-${fy}-${String(seq).padStart(4, "0")}`;
}
