import LegalDoc, { Clause } from "@/components/public/LegalDoc";

export const metadata = {
  title: "Terms of Service",
  description: "The terms that apply when you use Kamath Chess Academy's coaching platform.",
};

export default function TermsPage() {
  return (
    <LegalDoc
      title="Terms of Service"
      updated="14 September 2026"
      intro="These terms govern your use of the Kamath Chess Academy platform. Please read them before creating an account."
    >
      <Clause heading="1. Who we are">
        <p>
          Kamath Chess Academy (&ldquo;KCA&rdquo;, &ldquo;we&rdquo;) operates this chess training platform at
          kamathchessacademy.com, providing online coaching, practice tools, tournaments and progress reporting.
        </p>
      </Clause>

      <Clause heading="2. Accounts and eligibility">
        <p>
          You must give accurate details when registering and keep your password confidential. You are responsible for
          activity under your account.
        </p>
        <p>
          Many of our students are under 18. If you are under 18, a parent or guardian must consent to your use of the
          platform and to our processing of your personal data. By registering you confirm that this consent has been
          given.
        </p>
      </Clause>

      <Clause heading="3. Acceptable use">
        <p>You agree not to:</p>
        <ul className="list-disc space-y-1 pl-5 marker:text-kca-cyan">
          <li>use chess engines or outside assistance in rated games, tournaments or assessments;</li>
          <li>share your account, or use another person&rsquo;s account;</li>
          <li>harass, abuse or endanger any other member, including in class chat;</li>
          <li>attempt to disrupt, reverse-engineer or gain unauthorised access to the platform;</li>
          <li>copy or redistribute our coaching material, reports or repertoires outside your own study.</li>
        </ul>
        <p>
          We may suspend or close accounts that breach these rules. Fair-play decisions in rated play are made at our
          discretion.
        </p>
      </Clause>

      <Clause heading="4. Classes, scheduling and attendance">
        <p>
          Class times are published in your dashboard. We may reschedule or substitute a coach where necessary and will
          give as much notice as we can. Attendance is recorded by your coach and is visible to you and, for students
          under 18, to the linked parent or guardian.
        </p>
      </Clause>

      <Clause heading="5. Fees">
        <p>
          The platform is currently free to use during our initial testing period. Where academy fees apply, they are
          agreed with you directly and recorded in your dashboard. Fee records shown in the platform are for your
          reference; the academy&rsquo;s own records prevail in the event of a discrepancy.
        </p>
        <p>
          Cancellations and refunds are covered by our{" "}
          <a href="/refund" className="text-kca-cyan hover:underline">
            Refund &amp; Cancellation Policy
          </a>
          .
        </p>
      </Clause>

      <Clause heading="6. AI-generated coaching content">
        <p>
          Some features — move explanations, game reports, opponent dossiers and opening guides — are generated
          automatically from chess-engine analysis. They are a study aid, not professional advice, and may contain
          mistakes. Always apply your own judgement and your coach&rsquo;s guidance.
        </p>
      </Clause>

      <Clause heading="7. Your content">
        <p>
          You keep ownership of the games, PGNs and messages you submit. You grant us permission to store and process
          them to operate the platform and produce your analysis and reports.
        </p>
      </Clause>

      <Clause heading="8. Availability and liability">
        <p>
          We aim to keep the platform available but cannot guarantee uninterrupted service. To the extent permitted by
          law, we are not liable for indirect or consequential loss. Nothing in these terms limits liability that cannot
          be limited by law.
        </p>
      </Clause>

      <Clause heading="9. Changes and contact">
        <p>
          We may update these terms; material changes will be notified in the platform. Questions can be sent through
          the contact form on our website.
        </p>
      </Clause>
    </LegalDoc>
  );
}
