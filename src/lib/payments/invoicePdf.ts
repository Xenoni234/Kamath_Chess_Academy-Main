/**
 * Invoice PDF rendering.
 *
 * Follows the same shape as the dossier and report renderers (`src/lib/second/pdf.ts`):
 * build one HTML string, `setContent`, `page.pdf({ format: "A4" })`, close in a
 * `finally`. Chromium comes from the shared `launchBrowser()` so the container
 * flags are not forgotten here the way they were everywhere else.
 *
 * Every interpolated value goes through `htmlEscape` — an invoice carries a
 * student-supplied username and a staff-supplied description, and neither is
 * trustworthy markup.
 */
import { launchBrowser } from "@/lib/pdf/launch";

export type InvoiceDetails = {
  number: string;
  issuedAt: Date;
  studentName: string;
  studentEmail: string;
  amount: number;
  currency: string;
  description: string | null;
  method: string | null;
  paidAt: Date | null;
  status: string;
};

function htmlEscape(value: string) {
  return value.replace(/[&<>"']/g, (char) => {
    const entities: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
    return entities[char];
  });
}

function inr(amount: number, currency: string): string {
  const symbol = currency === "INR" ? "₹" : `${currency} `;
  return `${symbol}${amount.toFixed(2)}`;
}

function formatDate(date: Date): string {
  return date.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}

export function renderInvoiceHtml(invoice: InvoiceDetails): string {
  const paidLine = invoice.paidAt
    ? `Paid on ${formatDate(invoice.paidAt)}${invoice.method ? ` by ${htmlEscape(invoice.method)}` : ""}`
    : `Status: ${htmlEscape(invoice.status)}`;

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <style>
    body { font-family: Arial, sans-serif; color: #111827; margin: 40px; line-height: 1.5; }
    h1 { font-size: 26px; margin-bottom: 2px; }
    h2 { font-size: 17px; margin-top: 26px; border-bottom: 1px solid #e5e7eb; padding-bottom: 4px; }
    .sub { color: #6b7280; font-size: 12px; margin-bottom: 16px; }
    table { width: 100%; border-collapse: collapse; margin-top: 10px; font-size: 12px; }
    th, td { border: 1px solid #d1d5db; padding: 6px; text-align: left; }
    th { background: #f3f4f6; }
    td.amount, th.amount { text-align: right; }
    .total td { font-weight: bold; background: #f9fafb; }
    .muted { color: #4b5563; font-size: 12px; }
    .footnote { margin-top: 26px; font-size: 10px; color: #6b7280; }
  </style>
</head>
<body>
  <h1>Kamath Chess Academy</h1>
  <div class="sub">Invoice ${htmlEscape(invoice.number)} &middot; issued ${formatDate(invoice.issuedAt)}</div>

  <h2>Billed to</h2>
  <p class="muted">
    ${htmlEscape(invoice.studentName)}<br />
    ${htmlEscape(invoice.studentEmail)}
  </p>

  <h2>Details</h2>
  <table>
    <thead>
      <tr><th>Description</th><th class="amount">Amount</th></tr>
    </thead>
    <tbody>
      <tr>
        <td>${htmlEscape(invoice.description ?? "Academy fees")}</td>
        <td class="amount">${inr(invoice.amount, invoice.currency)}</td>
      </tr>
      <tr class="total">
        <td>Total</td>
        <td class="amount">${inr(invoice.amount, invoice.currency)}</td>
      </tr>
    </tbody>
  </table>

  <p class="muted">${paidLine}</p>

  <div class="footnote">
    This is a computer-generated invoice from Kamath Chess Academy and is valid without a signature.
    Questions about this invoice can be raised through the contact form on our website.
  </div>
</body>
</html>`;
}

export async function renderInvoicePdf(invoice: InvoiceDetails): Promise<Buffer> {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.setContent(renderInvoiceHtml(invoice), { waitUntil: "load" });
    return Buffer.from(await page.pdf({ format: "A4" }));
  } finally {
    await browser.close();
  }
}
