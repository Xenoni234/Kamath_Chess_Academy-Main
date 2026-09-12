import LegalDoc, { Clause } from "@/components/public/LegalDoc";

export const metadata = {
  title: "Privacy Policy",
  description: "How Kamath Chess Academy collects, uses and protects student and parent data under India's DPDPA 2023.",
};

export default function PrivacyPage() {
  return (
    <LegalDoc
      title="Privacy Policy"
      updated="14 September 2026"
      intro="How Kamath Chess Academy collects, uses and protects your personal data, in line with India's Digital Personal Data Protection Act, 2023."
    >
      <Clause heading="1. Data we collect">
        <ul className="list-disc space-y-1 pl-5 marker:text-kca-cyan">
          <li><strong>Account data</strong> — name/username, email, mobile number, and your role at the academy.</li>
          <li><strong>Chess data</strong> — games you play or import, puzzle attempts, ratings, analysis and reports.</li>
          <li><strong>Academy data</strong> — batches, class schedules, attendance and fee records.</li>
          <li><strong>Linked accounts</strong> — your FIDE ID, Lichess or Chess.com usernames, if you provide them.</li>
          <li><strong>Technical data</strong> — sign-in sessions and security/audit logs.</li>
        </ul>
      </Clause>

      <Clause heading="2. Why we use it">
        <p>
          To provide coaching and training tools, run classes and tournaments, produce your progress reports, keep fee
          records, secure your account, and communicate with you about the academy. We rely on the consent you give at
          registration, and on the necessity of processing to deliver the service you have asked for.
        </p>
        <p>We do not sell your personal data, and we do not use it for advertising.</p>
      </Clause>

      <Clause heading="3. Children's data">
        <p>
          Many of our students are children. We process a child&rsquo;s data only with the consent of a parent or
          guardian, obtained at registration. We do not carry out tracking, behavioural monitoring for advertising, or
          targeted advertising directed at children.
        </p>
        <p>
          A parent or guardian linked to a student can see that student&rsquo;s progress, classes, attendance and fees.
          Every such access by someone other than the student is recorded in our audit log.
        </p>
      </Clause>

      <Clause heading="4. Who can see your data">
        <p>
          Your coaches can see the progress of students in their own batches. Academy administrators can see account and
          fee records. Other students cannot see your reports, fees or attendance.
        </p>
        <p>
          We use service providers to run the platform. They process data on our instructions only:
        </p>
        <ul className="list-disc space-y-1 pl-5">
          <li>
            <strong>Supabase</strong> — database and hosting for your account, games and academy records (Mumbai, India).
          </li>
          <li>
            <strong>Upstash</strong> — cache and live presence data.
          </li>
          <li>
            <strong>Resend</strong> — sending verification codes, reports and invoices by email.
          </li>
          <li>
            <strong>Jitsi Meet (8x8)</strong> — live class video and audio, when a class uses the built-in video room.
          </li>
          <li>
            <strong>Groq and Anthropic</strong> — generating coaching text from your game data.
          </li>
          <li>
            <strong>Lichess and Chess.com</strong> — importing games, only when you give us a username or FIDE ID.
          </li>
          <li>
            <strong>Cloudinary</strong> — storing images you upload, such as a profile picture.
          </li>
          <li>
            <strong>Razorpay</strong> — processing payments, if and when online payments are enabled.
          </li>
        </ul>
      </Clause>

      <Clause heading="5. Retention">
        <p>
          We keep your data while your account is active and for as long as needed for legitimate academy records (such
          as fees). You can ask us to delete your account, after which we remove your personal data except where we must
          keep it by law.
        </p>
        <p>
          In practice that means we erase the information that identifies you — your name, email, phone number, linked
          chess accounts and profile details. Fee and invoice records are kept for the period required for financial and
          tax records, with your identifying details removed from them, so they can no longer be traced back to you.
        </p>
      </Clause>

      <Clause heading="6. Your rights">
        <p>Under the DPDPA you may:</p>
        <ul className="list-disc space-y-1 pl-5 marker:text-kca-cyan">
          <li>access the personal data we hold about you;</li>
          <li>ask us to correct or complete it;</li>
          <li>ask us to erase it;</li>
          <li>withdraw consent — including for optional marketing or SMS messages — at any time;</li>
          <li>nominate someone to exercise these rights on your behalf;</li>
          <li>raise a grievance with us, and escalate to the Data Protection Board of India.</li>
        </ul>
        <p>Withdrawing consent that is necessary for the service may mean we can no longer provide it.</p>
      </Clause>

      <Clause heading="7. Security">
        <p>
          Passwords are stored hashed, never in plain text. Sign-in uses secure, HTTP-only cookies, and access to
          personal data within the platform is restricted by role and recorded in an audit log.
        </p>
      </Clause>

      <Clause heading="8. Contact and grievances">
        <p>
          For any privacy question, or to exercise the rights above, contact us through the form on our website and mark
          your message for the attention of the Data Protection Officer. We will respond as required by the DPDPA.
        </p>
      </Clause>
    </LegalDoc>
  );
}
