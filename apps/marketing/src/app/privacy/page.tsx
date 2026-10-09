import type { Metadata } from 'next';
import Link from 'next/link';
import { BRAND } from '@axiom/config/brand';

export const metadata: Metadata = {
  title: 'Privacy policy',
  description:
    'How Axiom Minds handles personal information on Axiom Proof, your choices, and how to contact us about privacy.',
  alternates: { canonical: '/privacy' },
};

const sections = [
  ['scope', 'Who we are and scope'],
  ['information', 'Information and purposes'],
  ['choices', 'Your choices'],
  ['cookies', 'Cookies and technical information'],
  ['sharing', 'Who receives information'],
  ['location', 'Storage and international transfers'],
  ['retention', 'How long we keep information'],
  ['security', 'Security and automated assessments'],
  ['children', 'Children’s information'],
  ['requests', 'Privacy requests and grievances'],
  ['law', 'Indian law and policy updates'],
] as const;

const headingClass =
  'font-heading text-xl font-semibold tracking-tight text-indigo-500 sm:text-2xl';
const linkClass =
  'font-medium text-indigo-500 underline decoration-slate-300 underline-offset-4 hover:decoration-indigo-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4';

export default function PrivacyPage() {
  return (
    <article className="mx-auto max-w-4xl px-4 py-12 sm:px-6 sm:py-16 lg:px-8">
      <header>
        <p className="text-sm font-medium text-teal-700">{BRAND.company}</p>
        <h1 className="mt-3 font-heading text-3xl font-semibold tracking-tight text-indigo-500 sm:text-4xl">
          Privacy policy
        </h1>
        <p className="mt-3 text-sm text-slate-500">Effective and last updated: 10 October 2026</p>
        <p className="mt-6 text-base leading-7 text-slate-600">
          This policy explains what information we collect, why we use it, who receives it, and how
          you can make a privacy request when you use {BRAND.name}. You can contact us at{' '}
          <a className={linkClass} href={`mailto:${BRAND.privacyEmail}`}>
            {BRAND.privacyEmail}
          </a>
          .
        </p>
      </header>

      <nav
        aria-label="Privacy policy contents"
        className="mt-8 rounded-xl border border-slate-200 bg-mist-50 p-5 sm:p-6"
      >
        <h2 className="font-heading text-base font-semibold text-indigo-500">On this page</h2>
        <ol className="mt-4 grid list-inside list-decimal gap-3 text-sm sm:grid-cols-2">
          {sections.map(([id, label]) => (
            <li key={id}>
              <a className={linkClass} href={`#${id}`}>
                {label}
              </a>
            </li>
          ))}
        </ol>
      </nav>

      <div className="mt-10 space-y-10 text-base leading-7 text-slate-600 [&_section]:scroll-mt-24 [&_p]:mt-4 [&_ul]:mt-4 [&_ul]:list-disc [&_ul]:space-y-2 [&_ul]:pl-6">
        <section id="scope" aria-labelledby="scope-heading">
          <h2 id="scope-heading" className={headingClass}>
            1. Who we are and scope
          </h2>
          <p>
            {BRAND.company}, India, operates {BRAND.name} at {BRAND.primaryDomain} and the related
            Workbench at {BRAND.productDomain}. We decide the purposes of handling website
            inquiries, gap-scan submissions, business contacts, and our own account and service
            administration information.
          </p>
          <p>
            Where an organisation uses a client workspace to process information about its
            employees, customers, or other individuals, that organisation determines the purposes
            and provides the relevant notice. We process that information on its instructions under
            the applicable service agreement. Please direct requests about such records to that
            organisation; we can help route a request to it. This policy does not replace a
            customer’s privacy notice or contractual data protection terms.
          </p>
        </section>

        <section id="information" aria-labelledby="information-heading">
          <h2 id="information-heading" className={headingClass}>
            2. Information we collect and why
          </h2>
          <ul>
            <li>
              <strong>Contact inquiries:</strong> your name, email address, optional company name,
              message, and receipt and delivery records. We save the inquiry, review it, respond,
              and handle the conversation you initiate.
            </li>
            <li>
              <strong>Gap-scan assessment:</strong> your sector, employee band, whether your
              organisation processes children’s data or may be a Significant Data Fiduciary,
              questionnaire answers, and the resulting scores, findings, recommendations, report
              identifier, and assessment version. We use these to generate, save, and display your
              requested report.
            </li>
            <li>
              <strong>Optional follow-up and report delivery:</strong> the name, email address,
              phone number, and company you provide, together with your follow-up and marketing
              choices. We use these to send your report when delivery is available, arrange
              requested follow-up, and provide updates you opt into. Requesting an emailed report
              also gives us the recipient address you enter.
            </li>
            <li>
              <strong>Service and security records:</strong> session identifiers stored in hashed
              form, a protected report access token, request limits, and delivery status. These help
              keep reports accessible to their originating browser, prevent abuse, and investigate
              delivery or service problems.
            </li>
            <li>
              <strong>Workspace information:</strong> account and organisation details, access
              permissions, activity records, and records or documents submitted or connected by an
              authorised customer. We use these to administer the service and perform the work
              requested under that customer’s agreement.
            </li>
          </ul>
          <p>
            The public gap-scan uses questionnaire answers; it does not require a document upload.
            Please do not include passwords, Aadhaar or other identity numbers, payment details,
            health records, or personal records about other people in website messages or answers.
            If you submit information for another person, you must have authority to do so.
          </p>
        </section>

        <section id="choices" aria-labelledby="choices-heading">
          <h2 id="choices-heading" className={headingClass}>
            3. Your choices and withdrawal
          </h2>
          <p>
            You can browse without sending an inquiry. The contact form needs a name, email, and
            message to receive and answer your request; company is optional. You can turn off
            follow-up in the gap-scan and obtain an on-screen report without providing contact
            details. Receiving the quarterly readiness index is a separate optional choice. The
            current form also uses that choice to include the readiness index in your report.
          </p>
          <p>
            To withdraw permission for optional follow-up or marketing, email{' '}
            <a className={linkClass} href={`mailto:${BRAND.privacyEmail}`}>
              {BRAND.privacyEmail}
            </a>{' '}
            and tell us which communications to stop. Withdrawal does not affect earlier lawful
            processing. We may still send a response or report you specifically request, or a
            necessary service or security message. If you ask us to stop processing information
            needed for a service, we will explain which part of that service can no longer be
            provided.
          </p>
        </section>

        <section id="cookies" aria-labelledby="cookies-heading">
          <h2 id="cookies-heading" className={headingClass}>
            4. Cookies and technical information
          </h2>
          <p>
            After a successful gap-scan, we set an essential first-party cookie named{' '}
            <code className="rounded bg-slate-100 px-1.5 py-0.5 text-sm text-slate-800">
              __session
            </code>{' '}
            to let your browser access its saved reports. It expires seven days after it is set or
            renewed. It is inaccessible to page scripts and is sent securely on deployed HTTPS
            services. Older reports may use a cookie named{' '}
            <code className="rounded bg-slate-100 px-1.5 py-0.5 text-sm text-slate-800">
              gap_scan_access
            </code>
            .
          </p>
          <p>
            You can block or clear cookies in your browser. Doing so, or using a different browser,
            can prevent access to a saved report. Cookie expiry or deletion does not delete the
            report from our records. The public website does not currently include advertising
            pixels or third-party analytics scripts. Hosting and service providers may record
            technical request information, such as IP address, browser details, requested page,
            time, and errors, to deliver the site and maintain security. Separate Workbench sign-in
            cookies are governed by its account and service arrangements.
          </p>
        </section>

        <section id="sharing" aria-labelledby="sharing-heading">
          <h2 id="sharing-heading" className={headingClass}>
            5. Who receives information
          </h2>
          <p>
            Authorised members of our team receive information needed to answer inquiries, provide
            requested follow-up, operate the service, and resolve problems. We use service providers
            for hosting, database storage, authentication, email, and technical support, with access
            appropriate to the service they provide.
          </p>
          <p>
            When email delivery is enabled, Resend processes the recipient address and message
            content. Contact notifications include your inquiry and contact details. Report emails
            include your assessment and any supplied name, company, and phone number; copies go to
            our sales and founder contacts for follow-up. A report sent to an address you specify is
            also available to that recipient and their email provider, so check the address before
            sending it.
          </p>
          <p>
            We do not sell personal information. We may disclose information where required by law,
            to respond to lawful requests, protect people or the service, or obtain confidential
            professional advice. If our business is reorganised or transferred, relevant records may
            transfer subject to applicable privacy obligations.
          </p>
        </section>

        <section id="location" aria-labelledby="location-heading">
          <h2 id="location-heading" className={headingClass}>
            6. Storage and international transfers
          </h2>
          <p>
            Customer workspace hosting and location requirements are set out in the relevant service
            agreement. Website delivery, email providers, support, and recipients’ email systems may
            involve processing outside India. An India-hosted workspace does not mean every website
            request or email is processed only in India. Where applicable, transfers are subject to
            Indian law, required permissions, and contractual safeguards. Contact us about location
            requirements before submitting regulated or sensitive information.
          </p>
        </section>

        <section id="retention" aria-labelledby="retention-heading">
          <h2 id="retention-heading" className={headingClass}>
            7. How long we keep information
          </h2>
          <p>
            Inquiries and correspondence are kept for handling the request and related business
            records. Gap-scan answers and reports are stored so we can provide the assessment and
            requested follow-up. These records do not automatically expire when the seven-day
            browser cookie expires. You can ask us to erase your submission using the contact below.
          </p>
          <p>
            We assess retention against the purpose, ongoing service relationship, legal
            requirements, and any need to resolve a dispute or security incident. Customer workspace
            retention follows the applicable agreement and customer instructions; evidence or audit
            records may have mandatory retention periods. Where deletion is appropriate, it may be
            subject to backup cycles or a lawful retention requirement. We will explain any reason
            we need to retain information when responding to a request.
          </p>
        </section>

        <section id="security" aria-labelledby="security-heading">
          <h2 id="security-heading" className={headingClass}>
            8. Security and automated assessments
          </h2>
          <p>
            We use access restrictions, protected report access tokens, secure connections on
            deployed services, request validation, and abuse limits to protect the public workflows.
            No service can guarantee complete security. Keep your browser and emailed reports
            secure, and report suspected unauthorised access to our privacy contact. We handle
            security incidents and any required notifications under applicable law and customer
            agreements.
          </p>
          <p>
            The public questionnaire generates scores and recommendations using a versioned control
            library. Its optional sector benchmarks are editorial estimates. These automated
            assessments are guidance for human review and do not determine your legal rights or
            certify compliance. AI-assisted customer workspace processing, where enabled, is subject
            to that workspace’s configuration and service terms. Please obtain the relevant
            processing details before providing personal data for that use.
          </p>
        </section>

        <section id="children" aria-labelledby="children-heading">
          <h2 id="children-heading" className={headingClass}>
            9. Children’s information
          </h2>
          <p>
            Our website forms and business services are intended for people aged 18 or older. Please
            do not submit a child’s personal information through public forms. The gap-scan question
            about children’s data asks about your organisation’s practices; it does not request
            records about a child. If you believe a child has submitted personal information,
            contact us so we can review and take appropriate action. Customer processing involving
            children must follow applicable law and the customer’s authorised instructions.
          </p>
        </section>

        <section id="requests" aria-labelledby="requests-heading">
          <h2 id="requests-heading" className={headingClass}>
            10. Privacy requests and grievances
          </h2>
          <p>
            Contact {BRAND.company} for privacy questions, withdrawal, access to information about
            your submission, correction, or erasure at{' '}
            <a className={linkClass} href={`mailto:${BRAND.privacyEmail}`}>
              {BRAND.privacyEmail}
            </a>
            . For a complaint, use the subject “Privacy grievance” and describe the issue and
            outcome you seek. You can also use our{' '}
            <Link className={linkClass} href="/contact">
              contact page
            </Link>{' '}
            to raise a privacy concern.
          </p>
          <p>
            Include the email address used for your submission and, if available, the report
            identifier. Do not send passwords or identity documents with your initial request. We
            may ask for limited information to verify that the request concerns your records. We
            will review the request, explain our response or any applicable limitation, and direct
            customer workspace requests to the responsible organisation where necessary.
          </p>
          <p>
            We handle grievances within the period required by the law applicable to the complaint;
            where the 2011 sensitive personal information rules apply, that period is one month from
            receipt. If you are dissatisfied, reply to the same contact to seek further review.
            Statutory rights, including nomination and complaints to the Data Protection Board,
            apply when the relevant DPDP provisions are in force and applicable to your processing.
            This policy does not restrict any available legal remedy.
          </p>
        </section>

        <section id="law" aria-labelledby="law-heading">
          <h2 id="law-heading" className={headingClass}>
            11. Indian law and policy updates
          </h2>
          <p>
            This policy is read with applicable Indian law, including the Information Technology
            Act, 2000 and the 2011 rules on sensitive personal information where applicable. The
            Digital Personal Data Protection Act, 2023 and Rules, 2025 have phased commencement. As
            of this policy’s date, their principal processing duties and individual rights have not
            all commenced. We apply legal obligations as they take effect.
          </p>
          <p>
            You can read MeitY’s{' '}
            <a
              className={linkClass}
              href="https://www.meity.gov.in/static/uploads/2025/11/c56ceae6c383460ca69577428d36828b.pdf"
            >
              Act commencement notification
            </a>{' '}
            and its{' '}
            <a
              className={linkClass}
              href="https://www.meity.gov.in/documents/act-and-policies/digital-personal-data-protection-rules-2025-gDOxUjMtQWa"
            >
              Rules and corrigendum
            </a>
            . We update this policy when our practices or legal requirements change and show the new
            date here. Where a change requires a fresh notice or consent, we will provide it through
            the relevant service before that processing.
          </p>
        </section>
      </div>
    </article>
  );
}
