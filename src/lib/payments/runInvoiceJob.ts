/**
 * Generate an invoice for a completed payment: reserve a number, render the PDF,
 * persist the row, email the copy.
 *
 * Two invariants matter here.
 *
 * **Exactly one invoice per payment.** `Invoice.paymentId` is `@unique`, and this
 * job is reachable from two places (recording a payment as COMPLETED, and
 * settling a PENDING one) plus a gateway webhook that retries. The early
 * existence check is the fast path; the P2002 catch is the one that actually
 * holds under concurrency, because two callers can both pass the check before
 * either writes.
 *
 * **A number is reserved only once we are going to use it.** `reserveInvoiceNumber`
 * burns a sequence value, so it is called after the existence check, not before.
 * Gaps are acceptable; duplicates are not.
 *
 * The PDF lives in /tmp like every other generated document in this app — that is
 * ephemeral and per-instance, so the emailed attachment is the durable copy and
 * the download route says so when the file has aged out.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { reserveInvoiceNumber } from "./invoiceNumber";
import { renderInvoicePdf } from "./invoicePdf";
import { createNotification } from "@/lib/notify";

export type InvoiceJobData = { paymentId: string };

export async function runInvoiceJob(data: InvoiceJobData): Promise<void> {
  const { paymentId } = data;

  const payment = await db.payment.findUnique({
    where: { id: paymentId },
    select: {
      id: true,
      amount: true,
      currency: true,
      status: true,
      description: true,
      method: true,
      paidAt: true,
      user: { select: { id: true, username: true, email: true } },
      invoice: { select: { id: true } },
    },
  });

  if (!payment) {
    console.error(`[invoice] payment ${paymentId} not found`);
    return;
  }
  if (payment.status !== "COMPLETED") {
    console.log(`[invoice] payment ${paymentId} is ${payment.status} — no invoice issued`);
    return;
  }
  if (payment.invoice) {
    console.log(`[invoice] payment ${paymentId} already has an invoice — nothing to do`);
    return;
  }

  const number = await reserveInvoiceNumber();
  const issuedAt = new Date();

  let invoiceId: string;
  try {
    const created = await db.invoice.create({
      data: { paymentId: payment.id, number, issuedAt },
      select: { id: true },
    });
    invoiceId = created.id;
  } catch (error) {
    // P2002 on paymentId: a concurrent caller won the race. That is a success for
    // the invariant "one invoice per payment", not an error to surface.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      console.log(`[invoice] payment ${paymentId} was invoiced concurrently — standing down`);
      return;
    }
    throw error;
  }

  // The row exists and is authoritative from here. A PDF failure must not undo it
  // or the payment would be re-invoiced with a new number on the next attempt.
  try {
    const pdf = await renderInvoicePdf({
      number,
      issuedAt,
      studentName: payment.user.username,
      studentEmail: payment.user.email,
      amount: Number(payment.amount),
      currency: payment.currency,
      description: payment.description,
      method: payment.method,
      paidAt: payment.paidAt,
      status: payment.status,
    });

    const pdfPath = path.join("/tmp", `invoice-${invoiceId}.pdf`);
    await fs.writeFile(pdfPath, pdf);
    await db.invoice.update({ where: { id: invoiceId }, data: { pdfUrl: pdfPath } });

    const emailFrom = process.env.EMAIL_FROM;
    if (emailFrom) {
      const { Resend } = await import("resend");
      const resend = new Resend(process.env.RESEND_API_KEY);
      await resend.emails.send({
        from: emailFrom,
        to: payment.user.email,
        subject: `Invoice ${number} — Kamath Chess Academy`,
        html: `<p>Your invoice ${number} is attached.</p>`,
        attachments: [{ filename: `${number}.pdf`, content: pdf }],
      });
    }
  } catch (error) {
    console.error(`[invoice] PDF/email failed for ${invoiceId} (row kept):`, error);
  }

  await createNotification({
    userId: payment.user.id,
    type: "SYSTEM",
    title: "Invoice available",
    body: `Invoice ${number} for your payment is ready to download.`,
  }).catch(() => {});

  console.log(`[invoice] issued ${number} for payment ${paymentId}`);
}
