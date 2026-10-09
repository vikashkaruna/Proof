import { BRAND } from '@axiom/config';

export const metadata = { title: 'About' };

export default function AboutPage() {
  return (
    <main className="mx-auto max-w-3xl px-4 py-16 sm:px-6">
      <h1 className="font-heading text-3xl font-semibold tracking-tight text-indigo-500">
        About {BRAND.name}
      </h1>
      <p className="mt-4 text-lg text-slate-600">
        {BRAND.name} is the agentic DPDPA compliance platform from {BRAND.company}. We're built for
        the Indian mid-market — 200 to 1,000 employees, ₹50 to 500 crore revenue — facing real
        penalty exposure (up to ₹250 crore per contravention) without a privacy team and without the
        budget for ₹25 lakh-plus enterprise compliance suites.
      </p>

      <h2 className="mt-10 font-heading text-2xl font-semibold text-indigo-500">Why "Proof"?</h2>
      <p className="mt-3 text-slate-600">
        Because the buyer's real fear isn't "are we compliant?" — it's{' '}
        <em>"what do I show the Board when they ask?"</em> The Data Protection Board can issue
        inquiries at any time. When they do, the fiduciary must <em>demonstrate</em> compliance, not
        assert it. Forty competitors are called some variant of "consent" or "comply". We own
        "proof" — the thing the regulator will actually demand.
      </p>

      <h2 className="mt-10 font-heading text-2xl font-semibold text-indigo-500">How we work</h2>
      <p className="mt-3 text-slate-600">
        Twelve named AI agents — <strong>Drishti</strong> (discovery), <strong>Vibhaag</strong>{' '}
        (classification), <strong>Parikshan</strong> (assessment), <strong>Saakshi</strong>{' '}
        (evidence), <strong>Sudhaar</strong> (planning), <strong>Karya</strong> (execution),{' '}
        <strong>Samadhan</strong> (reconciliation), <strong>Lekha</strong> (audit),{' '}
        <strong>Nazar</strong> (regulatory watch), <strong>Prativedan</strong> (reporting),{' '}
        <strong>Pramaan</strong> (closure dossier), <strong>Sanket</strong> (market signal). Each
        has a contract, an autonomy ceiling, and tool permissions. The planning agent holds no write
        credentials — separation of duties between proposing and executing. Execution requires a
        signed, scope-bound approval token validated per action.
      </p>
      <p className="mt-3 text-slate-600">
        After approved execution, <strong>Samadhan</strong> checks recorded actions against the
        approved plan and scope, flagging discrepancies for human review. <strong>Pramaan</strong>{' '}
        brings findings, reconciled outcomes, evidence and audit records together into a closure
        dossier. An authorized human reviews the dossier before release; missing evidence or
        unresolved checks must not be presented as completed compliance.
      </p>
      <p className="mt-3 text-slate-600">
        Every action — agent or human, read or write — is written to an append-only, hash-chained
        audit ledger. You can hand the ledger to an auditor or to the DPB and it stands on its own.
      </p>

      <h2 className="mt-10 font-heading text-2xl font-semibold text-indigo-500">
        Where we're hosted
      </h2>
      <p className="mt-3 text-slate-600">
        All client data, evidence, and ledger entries are stored in{' '}
        <strong>{BRAND.dataResidencyRegion}</strong> on Amazon Web Services (AWS). For tasks
        involving personal data, large language model (LLM) processing runs within our own
        infrastructure, in the same Kubernetes cluster. Raw personal data is not sent to third-party
        AI providers.
      </p>
    </main>
  );
}
