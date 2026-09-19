'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { CONTROL_LIBRARY_COUNT } from '@axiom/control-library';
import { Button, Input, Label, Textarea, generateUUID } from '@axiom/ui';

const QUESTIONS = [
  {
    id: 'q1',
    prompt: 'Do you have a publicly accessible privacy policy on your website?',
    type: 'boolean' as const,
    mapsTo: 'DPDPA-GOV-002',
  },
  {
    id: 'q2',
    prompt:
      'Is the consent capture on your site/app a clear affirmative action (not pre-ticked, not implied)?',
    type: 'boolean' as const,
    mapsTo: 'DPDPA-CNS-001',
  },
  {
    id: 'q3',
    prompt: 'Can a user withdraw consent as easily as they gave it?',
    type: 'boolean' as const,
    mapsTo: 'DPDPA-CNS-004',
  },
  {
    id: 'q4',
    prompt: 'Do you have a named grievance officer / privacy contact published?',
    type: 'boolean' as const,
    mapsTo: 'DPDPA-DAT-003',
  },
  {
    id: 'q5',
    prompt:
      'Do you maintain a written Record of Processing Activities (RoPA) — purpose, data items, lawful basis, retention, processors?',
    type: 'boolean' as const,
    mapsTo: 'DPDPA-RCD-001',
  },
  {
    id: 'q6',
    prompt: 'Is personal data encrypted at rest (AES-256 or equivalent) and in transit (TLS 1.2+)?',
    type: 'boolean' as const,
    mapsTo: 'DPDPA-SEC-001',
  },
  {
    id: 'q7',
    prompt: 'Is multi-factor authentication enforced for admin access to personal data stores?',
    type: 'boolean' as const,
    mapsTo: 'DPDPA-SEC-001',
  },
  {
    id: 'q8',
    prompt: 'Do you have a documented breach response procedure with the 72-hour DPB clock?',
    type: 'boolean' as const,
    mapsTo: 'DPDPA-BRCH-001',
  },
  {
    id: 'q9',
    prompt: 'Have you inventoried all systems that hold personal data?',
    type: 'boolean' as const,
    mapsTo: 'DPDPA-RCD-002',
  },
  {
    id: 'q10',
    prompt:
      'Do you have signed Data Processing Agreements (DPAs) with every third party that processes personal data on your behalf?',
    type: 'boolean' as const,
    mapsTo: 'DPDPA-GOV-003',
  },
  {
    id: 'q11',
    prompt: 'Do you transfer any personal data outside India?',
    type: 'boolean' as const,
    mapsTo: 'DPDPA-XBR-001',
  },
  {
    id: 'q12',
    prompt: 'Have you conducted a Data Protection Impact Assessment (DPIA) in the past 12 months?',
    type: 'boolean' as const,
    mapsTo: 'DPDPA-DPIA-001',
  },
];

const SECTORS = [
  'BFSI',
  'Healthcare',
  'SaaS / Tech',
  'E-commerce / D2C',
  'Manufacturing',
  'Education / EdTech',
  'Logistics',
  'Hospitality',
  'Other',
];

export function GapScanForm() {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [sector, setSector] = useState('');
  const [employeeBand, setEmployeeBand] = useState('');
  const [processesChildren, setProcessesChildren] = useState<boolean | null>(null);
  const [isSdf, setIsSdf] = useState<boolean | null>(null);
  const [answers, setAnswers] = useState<Record<string, boolean>>({});
  const [contactName, setContactName] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [contactPhone, setContactPhone] = useState('');
  const [contactCompany, setContactCompany] = useState('');
  const [followUp, setFollowUp] = useState(true);
  const [marketingConsent, setMarketingConsent] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function setAnswer(qid: string, val: boolean) {
    setAnswers((prev) => ({ ...prev, [qid]: val }));
  }

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/gap-scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sector,
          employeeBand,
          processesChildrenData: processesChildren ?? undefined,
          isSdf: isSdf ?? undefined,
          answers,
          contactName: followUp ? contactName : undefined,
          contactEmail: followUp ? contactEmail : undefined,
          contactPhone: followUp ? contactPhone : undefined,
          contactCompany: followUp ? contactCompany : undefined,
          followUpRequested: followUp,
          marketingConsent,
          sessionId: generateUUID(),
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body?.error?.message ?? `HTTP ${res.status}`);
        return;
      }
      const body = await res.json();
      router.push(`/gap-scan/report/${body.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed');
    } finally {
      setSubmitting(false);
    }
  }

  // Step 0: sector / size
  // Step 1: 12 yes/no questions (one at a time, advance on each)
  // Step 2: contact info (optional)
  // Step 3: review & submit

  const totalSteps = 4;
  const progress = ((step + 1) / totalSteps) * 100;

  return (
    <div className="flex flex-col gap-6">
      <div className="h-1 w-full overflow-hidden rounded-full bg-mist-200">
        <div className="h-full bg-teal-500 transition-all" style={{ width: `${progress}%` }} />
      </div>

      {error && (
        <div className="rounded-md border border-ember-500 bg-ember-50 p-3 text-sm text-ember-700">
          {error}
        </div>
      )}

      {step === 0 && (
        <div className="flex flex-col gap-4">
          <h3 className="font-heading text-xl font-semibold text-indigo-500">
            Tell us about your business
          </h3>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="sector">Sector</Label>
            <select
              id="sector"
              value={sector}
              onChange={(e) => setSector(e.target.value)}
              className="flex h-10 rounded-md border border-slate-300 bg-white px-3 text-sm"
            >
              <option value="">Select…</option>
              {SECTORS.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="emp">Employee count</Label>
            <select
              id="emp"
              value={employeeBand}
              onChange={(e) => setEmployeeBand(e.target.value)}
              className="flex h-10 rounded-md border border-slate-300 bg-white px-3 text-sm"
            >
              <option value="">Select…</option>
              <option value="1-50">1–50</option>
              <option value="51-200">51–200</option>
              <option value="201-500">201–500</option>
              <option value="501-1000">501–1,000</option>
              <option value="1001-5000">1,001–5,000</option>
              <option value="5000+">5,000+</option>
            </select>
          </div>
          <div className="flex flex-col gap-2 rounded-md border border-slate-200 bg-mist-50 p-3">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={processesChildren ?? false}
                onChange={(e) => setProcessesChildren(e.target.checked)}
                className="h-4 w-4 rounded border-slate-300"
              />
              We process data of children (under 18)
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={isSdf ?? false}
                onChange={(e) => setIsSdf(e.target.checked)}
                className="h-4 w-4 rounded border-slate-300"
              />
              We are / may be a Significant Data Fiduciary (SDF)
            </label>
          </div>
          <div className="flex justify-end">
            <Button
              variant="primary"
              onClick={() => setStep(1)}
              disabled={!sector || !employeeBand}
            >
              Next
            </Button>
          </div>
        </div>
      )}

      {step === 1 && (
        <div className="flex flex-col gap-4">
          <h3 className="font-heading text-xl font-semibold text-indigo-500">
            {QUESTIONS.filter((q) => answers[q.id] !== undefined).length} of {QUESTIONS.length}{' '}
            answered
          </h3>
          <p className="text-sm text-slate-500">
            Answer as best you can. "I don't know" is honest — it counts as a gap.
          </p>
          <div className="flex max-h-[400px] flex-col gap-3 overflow-y-auto pr-1">
            {QUESTIONS.map((q) => (
              <div key={q.id} className="rounded-md border border-slate-200 p-3">
                <p className="text-sm text-slate-700">{q.prompt}</p>
                <p className="mt-0.5 text-[10px] uppercase tracking-wider text-slate-400">
                  Maps to: {q.mapsTo}
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {[
                    { v: true, l: 'Yes', c: 'teal' },
                    { v: false, l: 'No', c: 'ember' },
                  ].map((opt) => (
                    <button
                      key={String(opt.v)}
                      type="button"
                      onClick={() => setAnswer(q.id, opt.v)}
                      className={
                        answers[q.id] === opt.v
                          ? 'rounded-md border-2 border-indigo-500 bg-indigo-50 px-3 py-1 text-sm font-medium text-indigo-700'
                          : 'rounded-md border border-slate-300 bg-white px-3 py-1 text-sm text-slate-700 hover:bg-mist-100'
                      }
                    >
                      {opt.l}
                    </button>
                  ))}
                  <button
                    type="button"
                    onClick={() => setAnswer(q.id, false)}
                    className="rounded-md border border-dashed border-slate-300 bg-white px-3 py-1 text-sm text-slate-500 hover:bg-mist-100"
                  >
                    I don't know
                  </button>
                </div>
              </div>
            ))}
          </div>
          <div className="flex justify-between">
            <Button variant="ghost" onClick={() => setStep(0)}>
              Back
            </Button>
            <Button
              variant="primary"
              onClick={() => setStep(2)}
              disabled={Object.keys(answers).length < QUESTIONS.length}
            >
              Next
            </Button>
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="flex flex-col gap-4">
          <h3 className="font-heading text-xl font-semibold text-indigo-500">
            Want a personalised walkthrough?
          </h3>
          <p className="text-sm text-slate-500">
            Optional. Add your details and the founder will reach out within 1 business day to walk
            through your findings. No newsletter, no spam.
          </p>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={followUp}
              onChange={(e) => setFollowUp(e.target.checked)}
              className="h-4 w-4 rounded border-slate-300"
            />
            Yes, I'd like a free 30-min walkthrough
          </label>
          {followUp && (
            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="cn">Name</Label>
                <Input
                  id="cn"
                  value={contactName}
                  onChange={(e) => setContactName(e.target.value)}
                  placeholder="Ravi Sharma"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="ce">Email</Label>
                <Input
                  id="ce"
                  type="email"
                  value={contactEmail}
                  onChange={(e) => setContactEmail(e.target.value)}
                  placeholder="you@company.com"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="cp">Phone</Label>
                <Input
                  id="cp"
                  type="tel"
                  value={contactPhone}
                  onChange={(e) => setContactPhone(e.target.value)}
                  placeholder="+91 98765 43210"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="cc">Company</Label>
                <Input
                  id="cc"
                  value={contactCompany}
                  onChange={(e) => setContactCompany(e.target.value)}
                  placeholder="Acme Fintech Pvt Ltd"
                />
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={marketingConsent}
                  onChange={(e) => setMarketingConsent(e.target.checked)}
                  className="h-4 w-4 rounded border-slate-300"
                />
                Send me the quarterly readiness index (optional)
              </label>
            </div>
          )}
          <div className="flex justify-between">
            <Button variant="ghost" onClick={() => setStep(1)}>
              Back
            </Button>
            <Button variant="primary" onClick={() => setStep(3)}>
              Review
            </Button>
          </div>
        </div>
      )}

      {step === 3 && (
        <div className="flex flex-col gap-4">
          <h3 className="font-heading text-xl font-semibold text-indigo-500">
            Ready to generate your report
          </h3>
          <div className="rounded-md border border-slate-200 bg-mist-50 p-4 text-sm">
            <p className="font-medium text-slate-700">Summary</p>
            <ul className="mt-2 flex flex-col gap-1 text-slate-600">
              <li>Sector: {sector}</li>
              <li>Size: {employeeBand} employees</li>
              <li>Children data: {processesChildren ? 'Yes' : 'No'}</li>
              <li>SDF: {isSdf ? 'Yes / Possibly' : 'No'}</li>
              <li>
                Answered: {Object.keys(answers).length} of {QUESTIONS.length}
              </li>
            </ul>
          </div>
          <p className="text-xs text-slate-500">
            On submit, your answers are scored against library v0.1.0 ({CONTROL_LIBRARY_COUNT} DPDPA
            controls) and a prioritised report is generated in &lt; 30 seconds. You can save the
            report as PDF from the result page.
          </p>
          <div className="flex justify-between">
            <Button variant="ghost" onClick={() => setStep(2)}>
              Back
            </Button>
            <Button
              variant="accent"
              size="lg"
              onClick={submit}
              loading={submitting}
              disabled={followUp && (!contactName || !contactEmail || !contactCompany)}
            >
              Generate my report
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
