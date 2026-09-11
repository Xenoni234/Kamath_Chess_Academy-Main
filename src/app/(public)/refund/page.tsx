import LegalDoc, { Clause } from "@/components/public/LegalDoc";

export const metadata = { title: "Refund & Cancellation Policy | Kamath Chess Academy" };

/**
 * Refund and Cancellation Policy.
 *
 * Written because the site's footer already advertised a "Refund Policy" that did
 * not exist, and because a payment gateway will not activate a merchant account
 * without one that states a specific refund window. The terms below are a
 * reasonable default for a coaching academy — they are NOT the academy's decided
 * policy, which is why the draft banner is the first thing on the page.
 */
export default function RefundPage() {
  return (
    <LegalDoc
      title="Refund & Cancellation Policy"
      updated="September 2026"
      intro="How fees, cancellations and refunds work at Kamath Chess Academy."
    >
      <p className="rounded-lg border border-kca-warning/40 bg-kca-surface-2 p-4 text-sm text-kca-warning">
        <strong>DRAFT — not yet approved by the academy.</strong> These terms are a starting point and have not been
        reviewed. Please replace or confirm them before relying on this page.
      </p>

      <Clause heading="1. Scope">
        <p>
          This policy covers fees paid to Kamath Chess Academy for coaching programmes, class batches and tournament
          entries booked through kamathchessacademy.com. It sits alongside our{" "}
          <a href="/terms" className="text-kca-cyan hover:underline">
            Terms of Service
          </a>
          .
        </p>
        <p>
          The platform is currently free to use during our initial testing period. Where fees apply, they are agreed
          with you directly and recorded in your dashboard.
        </p>
      </Clause>

      <Clause heading="2. Fees and billing cycle">
        <p>
          Coaching fees are billed per calendar month, in advance, unless a different arrangement is agreed in writing.
          Your dashboard shows what has been recorded as paid and what is outstanding.
        </p>
      </Clause>

      <Clause heading="3. Cancelling your enrolment">
        <p>
          You may cancel at any time by telling us at least <strong>7 days before your next billing date</strong>. We
          will not bill you for the following cycle. Classes in the cycle you have already paid for remain available to
          you until it ends.
        </p>
        <p>Cancellations requested with less than 7 days&rsquo; notice take effect from the cycle after next.</p>
      </Clause>

      <Clause heading="4. Classes cancelled by the academy">
        <p>
          If we cancel a scheduled class and cannot offer a replacement session, you may choose either a pro-rata credit
          against your next invoice or a pro-rata refund. If we discontinue a programme mid-cycle, we refund the unused
          portion in full.
        </p>
      </Clause>

      <Clause heading="5. Classes missed by the student">
        <p>
          Fees for classes a student does not attend are not refundable, because the coach&rsquo;s time is reserved in
          advance. Where you tell us ahead of time, we will try to offer a make-up session, subject to coach
          availability. This is an accommodation rather than an entitlement.
        </p>
      </Clause>

      <Clause heading="6. Tournament entry fees">
        <p>
          Tournament entries can be withdrawn for a full refund until the pairings for the first round are published.
          After that point entry fees are non-refundable, as the event schedule has been built around the entrants.
        </p>
      </Clause>

      <Clause heading="7. How refunds are paid">
        <p>
          Approved refunds are returned to the original payment method. We process them within{" "}
          <strong>7 to 10 business days</strong> of approving the request. Your bank or card issuer may take additional
          time to show the credit.
        </p>
      </Clause>

      <Clause heading="8. How to request a refund or cancellation">
        <p>
          Send your request through the contact form on our website, or email us at the address in the site footer,
          including the student&rsquo;s name and what the request relates to. We aim to respond within 5 business days.
        </p>
      </Clause>

      <Clause heading="9. Governing law">
        <p>
          This policy is governed by the laws of India, and disputes are subject to the jurisdiction of the courts of
          Mumbai, Maharashtra.
        </p>
      </Clause>
    </LegalDoc>
  );
}
