'use client';

import { useId, useLayoutEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { z } from 'zod';
import { publicControlAssessmentV2Schema, type PublicControlAssessmentV2 } from '@axiom/types';
import {
  PUBLIC_CONTROL_CATALOGUE_V2_MANIFEST_TEXT,
  publicControlCatalogueV2Manifest,
  publicEvidenceCatalogueRowsMatchV2,
} from '@axiom/control-library';
import { sourceRequest, SourceWorkflowError } from './source-request';

const responseSchema = z
  .object({
    data: z
      .object({
        assessment: publicControlAssessmentV2Schema,
        catalogueManifestText: z.string().max(PUBLIC_CONTROL_CATALOGUE_V2_MANIFEST_TEXT.length),
        captureReceipt: z.string().min(1).max(200),
      })
      .strict(),
  })
  .strict();
type Result = z.infer<typeof responseSchema>['data'];
type Props = {
  tenantId: string;
  engagementId: string;
  checkId: string;
  recaptureContent?: React.ReactNode;
};
type Evidence = PublicControlAssessmentV2['controls'][number]['questions'][number]['evidence'];
const stateLabels: Record<Evidence['state'], string> = {
  public_candidate: 'Static public observation; human verification needed',
  declared_only: 'Public declaration only; implementation unverified',
  mixed_public_evidence: 'Public observations and declarations; further proof needed',
  internal_unknown: 'Internal evidence required; public pages cannot establish this',
  source_unavailable: 'Relevant public source unavailable',
  source_truncated: 'Relevant public source partly inspected or retained',
  not_observed_in_scope: 'Not observed in the bounded public pages; absence is not established',
};
const reasonLabels: Record<
  PublicControlAssessmentV2['source']['pages'][number]['coverageReasons'][number],
  string
> = {
  unsupported_foreign_markup: 'Unsupported SVG or other foreign markup excluded',
  node_budget: 'HTML node inspection limit reached',
  text_node_budget: 'Text node inspection limit reached',
  text_length_budget: 'Text inspection length limit reached',
  excerpt_limit: 'Retained excerpt length limit reached',
  unsafe_text_suppressed: 'Potentially unsafe notice text withheld',
  sensitive_control_suppressed: 'Sensitive control metadata withheld',
  candidate_limit: 'Evidence candidate limit reached; additional candidates not retained',
};
function Disposition({ value }: { value: Evidence }) {
  return (
    <p className="text-sm text-slate-700">
      {stateLabels[value.state]}
      {value.candidateOrdinals.length > 0
        ? ` · Evidence ${value.candidateOrdinals.map((n) => `#${n}`).join(', ')}`
        : ''}
    </p>
  );
}

/** A separate deterministic, read-only review. It never invokes an agent or captures a website. */
export function PublicControlReview(props: Props) {
  return <Review key={`${props.tenantId}/${props.engagementId}/${props.checkId}`} {...props} />;
}
function Review({ tenantId, engagementId, checkId, recaptureContent }: Props) {
  const helpId = useId();
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [recapture, setRecapture] = useState(false);
  const active = useRef(false),
    pending = useRef<AbortController | null>(null);
  useLayoutEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      pending.current?.abort();
    };
  }, []);
  const valid = [tenantId, engagementId, checkId].every((id) => z.uuid().safeParse(id).success);
  async function load() {
    if (!valid || pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setError('');
    setRecapture(false);
    setResult(null);
    try {
      const response = responseSchema.safeParse(
        await sourceRequest(
          tenantId,
          `/public-website-checks/${checkId.toLowerCase()}/control-review?engagementId=${encodeURIComponent(engagementId.toLowerCase())}`,
          { signal: controller.signal },
        ),
      );
      if (!response.success) throw new Error('review_response_refused');
      const data = response.data.data,
        source = data.assessment.source;
      if (
        source.tenantId !== tenantId.toLowerCase() ||
        source.engagementId !== engagementId.toLowerCase() ||
        source.checkId !== checkId.toLowerCase() ||
        data.catalogueManifestText !== PUBLIC_CONTROL_CATALOGUE_V2_MANIFEST_TEXT ||
        !publicEvidenceCatalogueRowsMatchV2(data.assessment.controls)
      )
        throw new Error('review_scope_refused');
      if (active.current && !controller.signal.aborted) setResult(data);
    } catch (reason) {
      if (!active.current || controller.signal.aborted) return;
      if (
        reason instanceof SourceWorkflowError &&
        reason.readRefusal?.code === 'website_recapture_required'
      ) {
        setRecapture(true);
        setError(
          'This saved check has no richer public evidence capture. Capture fresh evidence for the selected website below, or use Connectors and select the new saved check. Earlier evidence remains unchanged.',
        );
      } else
        setError(
          'The website control review could not be verified or loaded. Refresh your selection or try again when the service is available.',
        );
    } finally {
      if (pending.current === controller) pending.current = null;
      if (active.current && !controller.signal.aborted) setBusy(false);
    }
  }
  const manifest = result ? publicControlCatalogueV2Manifest() : null;
  return (
    <section
      aria-label="Website source control review"
      className="w-full min-w-0 space-y-4 break-words rounded-xl border border-slate-200 bg-white p-3 sm:p-4"
    >
      <div>
        <h2 className="text-lg font-semibold text-indigo-900">Website source control review</h2>
        <p className="text-sm text-slate-600">
          A deterministic review of retained public evidence against the engagement’s published
          DPDPA control library. This is separate from Drishti and Vibhaag runs. It does not produce
          a compliance score, legal conclusion or completed human judgment.
        </p>
      </div>
      <button
        type="button"
        className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-indigo-900 disabled:opacity-50"
        disabled={!valid || busy}
        aria-describedby={helpId}
        onClick={() => void load()}
      >
        Review website against DPDPA controls
      </button>
      <p id={helpId} className="text-sm text-slate-600">
        {busy
          ? 'Loading the retained public control review…'
          : !valid
            ? 'Select an engagement and saved website check above.'
            : 'Read-only: loads the existing capture without fetching the website or starting an agent.'}
      </p>
      {error && (
        <p role="alert" className="text-sm text-[#D9534F]">
          {error}
        </p>
      )}
      {recapture &&
        (recaptureContent ?? (
          <Link href="/connectors" className="text-sm text-teal-700 underline">
            Audit website again in Connectors
          </Link>
        ))}
      {result && manifest && (
        <>
          <p className="font-medium text-indigo-900">
            Human review required · {result.assessment.controls.length} controls · Library{' '}
            {result.assessment.catalogue.libraryVersion}
          </p>
          <p className="text-sm text-slate-600">
            Captured evidence is immutable. This view deterministically evaluates the same retained
            bytes and mapping; it is not a separately recorded agent assessment. Public declarations
            and visible controls never prove backend operation, valid consent or sufficient internal
            evidence.
          </p>
          <p className="text-sm text-slate-600">
            Assessment date: {result.assessment.source.assessmentDate}. Catalogue default effective
            date: {result.assessment.catalogue.defaultEffectiveFrom}. Individual control effective
            dates are not present in this source; applicability and commencement require legal
            review. Children’s-data and Significant Data Fiduciary applicability remain unverified.
          </p>
          <section aria-label="Public page coverage" className="space-y-2">
            <h3 className="font-semibold text-indigo-900">Public page coverage</h3>
            <p className="text-sm text-slate-600">
              Bounded static HTML only: starting page and selected privacy, contact, terms and
              consent pages. No whole-site crawl, JavaScript interaction, form submission,
              authenticated area or backend inspection.
            </p>
            <ul className="space-y-2">
              {result.assessment.source.pages.map((page) => (
                <li key={page.page} className="rounded border border-slate-200 p-2 text-sm">
                  <span className="font-medium capitalize">{page.page}</span>:{' '}
                  {page.state === 'examined'
                    ? 'Static HTML inspected'
                    : page.state === 'unavailable'
                      ? 'Page unavailable'
                      : 'Page not examined'}
                  {page.truncated ? ' · Partial content coverage' : ''}
                  {page.coverageReasons.length > 0 && (
                    <ul className="ml-4 list-disc">
                      {page.coverageReasons.map((reason) => (
                        <li key={reason}>{reasonLabels[reason]}</li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
            {result.assessment.source.candidatesTruncated && (
              <p className="text-sm">
                Evidence candidates were capped; additional candidates remain unrecorded.
              </p>
            )}
          </section>
          <section aria-label="Public evidence candidates" className="space-y-2">
            <h3 className="font-semibold text-indigo-900">Public evidence candidates</h3>
            {result.assessment.source.candidates.length === 0 ? (
              <p className="text-sm">
                No candidates retained in this bounded capture. This does not establish absence or
                compliance.
              </p>
            ) : (
              <ol className="space-y-2">
                {result.assessment.source.candidates.map((candidate) => (
                  <li
                    key={candidate.ordinal}
                    className="space-y-1 rounded border border-slate-200 p-2 text-sm"
                  >
                    <p className="font-medium">
                      Evidence #{candidate.ordinal} · {candidate.locator.page} ·{' '}
                      {candidate.facet.replaceAll('_', ' ')}
                    </p>
                    <p>
                      {candidate.kind === 'public_declaration'
                        ? 'Public declaration; implementation unverified'
                        : 'Static observation; operation unverified'}{' '}
                      · Context: {candidate.context.replaceAll('_', ' ')} · Human review required
                    </p>
                    <blockquote className="break-words border-l-2 border-slate-300 pl-2">
                      {candidate.excerpt}
                    </blockquote>
                    {candidate.staticControl && (
                      <p>
                        Recorded {candidate.staticControl.element}
                        {candidate.staticControl.inputType
                          ? ` (${candidate.staticControl.inputType})`
                          : ''}
                        ; likely category:{' '}
                        {candidate.staticControl.likelyDataCategory.replaceAll('_', ' ')}. Checked
                        attribute: {candidate.staticControl.checkedAttribute ? 'present' : 'absent'}
                        ; required attribute:{' '}
                        {candidate.staticControl.requiredAttribute ? 'present' : 'absent'}; disabled
                        attribute:{' '}
                        {candidate.staticControl.disabledAttribute ? 'present' : 'absent'}. These
                        are static attributes, not verified behaviour.
                      </p>
                    )}
                  </li>
                ))}
              </ol>
            )}
          </section>
          <section aria-label="DPDPA control evidence coverage" className="space-y-2">
            <h3 className="font-semibold text-indigo-900">DPDPA control evidence coverage</h3>
            {result.assessment.controls.map((control, index) => {
              const reference = manifest.controls[index]!.control;
              return (
                <details key={control.controlId} className="rounded border border-slate-200 p-3">
                  <summary className="cursor-pointer font-medium text-indigo-900">
                    {control.controlId} · {reference.title}
                  </summary>
                  <div className="mt-2 space-y-3">
                    <p className="text-sm">{reference.obligation}</p>
                    <p className="text-sm">
                      {control.applicability === 'conditional_unknown'
                        ? 'Conditional applicability is unverified; internal evidence is required.'
                        : 'General control; internal evidence is still required.'}
                    </p>
                    <p className="text-xs text-slate-600">
                      Citations:{' '}
                      {reference.citations.map((c) => `${c.instrument} ${c.reference}`).join(' · ')}
                    </p>
                    <h4 className="font-medium">Questions</h4>
                    <ol className="space-y-2">
                      {control.questions.map((question, i) => (
                        <li key={question.questionId}>
                          <p className="text-sm">
                            {question.questionId}: {reference.assessmentQuestions[i]!.prompt}
                          </p>
                          <Disposition value={question.evidence} />
                        </li>
                      ))}
                    </ol>
                    <h4 className="font-medium">Evidence requirements</h4>
                    <ol className="space-y-2">
                      {control.evidenceRequirements.map((requirement) => (
                        <li key={requirement.index}>
                          <p className="text-sm">
                            {reference.evidenceRequired[requirement.index]!.description}
                          </p>
                          <Disposition value={requirement.evidence} />
                          <p className="text-xs text-slate-600">
                            Internal verification required; public evidence is not automatically
                            sufficient.
                          </p>
                        </li>
                      ))}
                    </ol>
                  </div>
                </details>
              );
            })}
          </section>
          <details className="rounded border border-slate-200 p-3 text-sm">
            <summary className="cursor-pointer font-medium text-indigo-900">
              Capture provenance and hashes
            </summary>
            <dl className="mt-2 space-y-1 break-all">
              <dt>Capture receipt</dt>
              <dd>{result.captureReceipt}</dd>
              <dt>Retained payload SHA-256</dt>
              <dd>
                <code>{result.assessment.source.projectionSha256}</code>
              </dd>
              <dt>Published catalogue manifest SHA-256</dt>
              <dd>
                <code>{result.assessment.catalogue.manifestSha256}</code>
              </dd>
              <dt>Extractor / mapping</dt>
              <dd>
                {result.assessment.source.extractorVersion} /{' '}
                {result.assessment.catalogue.mappingVersion}
              </dd>
            </dl>
          </details>
        </>
      )}
    </section>
  );
}
