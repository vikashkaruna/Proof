/** New source8/document8 only. Earlier requests, renderers and approvals stay immutable. */
import { canonicalJson } from '@axiom/ledger';
import {
  PUBLIC_COVERAGE_PAGES,
  publicControlPayloadV2Schema,
  publicCoverageClarificationSnapshotSchema,
} from '@axiom/types';
import { z } from 'zod';
import {
  BrandedDocumentV7Schema,
  buildBrandedReport,
  renderBrandedDraft,
  verifyBrandedSource,
} from './branded-report';
import {
  COVERAGE_FIRST_MAX_BYTES,
  coverageFirstHash as hash,
  parseCoverageFirstJson as parseJson,
  verifyCoverageFirstSource,
} from './coverage-first-source';
import {
  buildCoverageFirstReport,
  renderCoverageFirstDocumentPresentation,
  type CoverageFirstBuildInput,
} from './coverage-first-report';
import {
  buildQuestionnaireEvidenceReport,
  renderQuestionnaireDocumentPresentation,
} from './questionnaire-evidence-report';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const receipt = z
  .string()
  .max(40)
  .regex(/^[1-9][0-9]*$/);
export const ClarifiedSourceV8Schema = z
  .object({
    schema_version: z.literal(8),
    kind: z.literal('clarified_report_source'),
    serialization: z.literal('axiom-clarified-report-source-json-1'),
    report_kind: z.enum(['board', 'auditor']),
    retained_source: z.object({ text: z.string().min(1), sha256: digest }).strict(),
    owner_clarification: z
      .object({
        snapshot_text: z.string().min(2),
        snapshot_sha256: digest,
        receipt_id: receipt,
      })
      .strict()
      .nullable(),
  })
  .strict();
const clarifiedFields = {
  schema_version: z.literal(8),
  source_sha256: digest,
  branded_source_sha256: digest,
  owner_coverage_clarification: publicCoverageClarificationSnapshotSchema.nullable(),
  owner_clarification_sha256: digest.nullable(),
  owner_clarification_receipt: receipt.nullable(),
};
export const ClarifiedDocumentV8Schema = z.union([
  BrandedDocumentV7Schema.options[0]
    .omit({ schema_version: true, source_sha256: true })
    .extend(clarifiedFields)
    .strict(),
  BrandedDocumentV7Schema.options[1]
    .omit({ schema_version: true, source_sha256: true })
    .extend(clarifiedFields)
    .strict(),
]);
export type ClarifiedDocumentV8 = z.infer<typeof ClarifiedDocumentV8Schema>;
type Scope = Pick<
  CoverageFirstBuildInput,
  'tenantId' | 'requestId' | 'engagementId' | 'assessmentRunId'
>;

export function verifyClarifiedSource(sourceText: string, sourceSha256: string, scope: Scope) {
  try {
    if (hash(sourceText) !== sourceSha256) throw Error();
    const envelope = ClarifiedSourceV8Schema.parse(parseJson(sourceText, COVERAGE_FIRST_MAX_BYTES));
    if (canonicalJson(envelope) !== sourceText) throw Error();
    const branded = verifyBrandedSource(
      envelope.retained_source.text,
      envelope.retained_source.sha256,
      scope,
    );
    if (branded.envelope.report_kind !== envelope.report_kind) throw Error();
    const bundle = envelope.owner_clarification;
    const clarification = bundle
      ? publicCoverageClarificationSnapshotSchema.parse(parseJson(bundle.snapshot_text, 262144))
      : null;
    if (bundle && hash(bundle.snapshot_text) !== bundle.snapshot_sha256) throw Error();
    if (branded.version === 5) {
      if (clarification) throw Error();
      return { envelope, branded, clarification, pages: null };
    }
    const publicSource = verifyCoverageFirstSource(branded.inner.text, branded.inner.sha256, {
      tenantId: scope.tenantId,
      requestId: scope.requestId,
      engagementId: scope.engagementId,
      assessmentRunId: scope.assessmentRunId,
    });
    const capture = publicSource.source.human_control_review.capture;
    const payload = publicControlPayloadV2Schema.parse(parseJson(capture.payload_text, 524288));
    const kinds = payload.pages.map((page) => page.page);
    if (new Set(kinds).size !== kinds.length) throw Error();
    const pages = PUBLIC_COVERAGE_PAGES.map((page) => {
      const recorded = payload.pages.find((candidate) => candidate.page === page);
      return {
        page,
        state: recorded?.state ?? ('unexamined' as const),
        truncated: recorded?.truncated ?? false,
        coverageReasons: recorded?.coverageReasons ?? [],
        presentInCapture: Boolean(recorded),
      };
    });
    const incomplete = pages.filter((page) => page.state !== 'examined' || page.truncated);
    if (incomplete.length && !clarification) throw Error();
    if (clarification) {
      if (
        clarification.tenantId !== scope.tenantId ||
        clarification.request.engagementId !== scope.engagementId ||
        clarification.request.checkId !== capture.check_id ||
        clarification.request.payloadSha256 !== capture.payload_sha256 ||
        clarification.request.expectedPreviousRevisionId !== clarification.previousRevisionId ||
        clarification.request.clarifications.length !== incomplete.length
      )
        throw Error();
      for (const page of incomplete) {
        const declared = clarification.request.clarifications.find(
          (item) => item.page === page.page,
        );
        if (
          !declared ||
          declared.sourceState !== page.state ||
          declared.sourceTruncated !== page.truncated
        )
          throw Error();
      }
    }
    return { envelope, branded, clarification, pages };
  } catch {
    throw Error('clarified_source_refused');
  }
}

export function buildClarifiedReport(input: CoverageFirstBuildInput): ClarifiedDocumentV8 {
  const verified = verifyClarifiedSource(input.sourceText, input.sourceSha256, input);
  const base = buildBrandedReport({
    ...input,
    sourceText: verified.envelope.retained_source.text,
    sourceSha256: verified.envelope.retained_source.sha256,
  });
  return ClarifiedDocumentV8Schema.parse({
    ...base,
    schema_version: 8,
    source_sha256: input.sourceSha256,
    branded_source_sha256: verified.envelope.retained_source.sha256,
    owner_coverage_clarification: verified.clarification,
    owner_clarification_sha256: verified.envelope.owner_clarification?.snapshot_sha256 ?? null,
    owner_clarification_receipt: verified.envelope.owner_clarification?.receipt_id ?? null,
  });
}

const esc = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
const pageNames = {
  root: 'Home page',
  privacy: 'Privacy notice',
  contact: 'Contact and grievance channels',
  terms: 'Terms',
  consent: 'Consent and withdrawal information',
};
const categoryNames = {
  not_public: 'Owner says the information is not public',
  not_found: 'Owner says a public page was not located',
  access_blocked: 'Owner reports an access restriction',
  interactive_content: 'Owner reports interactive content',
  not_applicable: 'Owner declares it not applicable; review required',
  needs_investigation: 'Owner requests further investigation',
  other: 'Other owner explanation',
};
const reasonNames: Record<string, string> = {
  unsupported_foreign_markup:
    'SVG or other foreign markup was excluded from text extraction. This does not establish a missing privacy practice.',
  node_budget: 'The bounded page-node examination limit was reached.',
  text_node_budget: 'The bounded text-node examination limit was reached.',
  text_length_budget: 'The retained text-length limit was reached.',
  excerpt_limit: 'Only bounded public excerpts were retained.',
  unsafe_text_suppressed: 'Potentially unsafe text was excluded.',
  sensitive_control_suppressed: 'Sensitive form controls were excluded.',
  candidate_limit: 'The retained public-signal limit was reached.',
};
function appendix(verified: ReturnType<typeof verifyClarifiedSource>) {
  if (!verified.pages)
    return '<section aria-label="Public-page coverage explanation"><h2>Public-page coverage explanation</h2><p>This report uses questionnaire declarations and internal evidence references. It has no retained public-website capture, so this report does not establish that privacy, contact, terms or consent pages were examined.</p></section>';
  const entries = verified.pages.map((page) => {
    const declared = verified.clarification?.request.clarifications.find(
      (item) => item.page === page.page,
    );
    const status = !page.presentInCapture
      ? 'Unexamined — this page kind is not present in the retained capture'
      : page.state === 'examined'
        ? page.truncated
          ? 'Examined public text — partial extraction'
          : 'Examined public text'
        : page.state === 'unavailable'
          ? 'Unavailable to the retained public capture'
          : 'Unexamined — no public examination was retained';
    const limitation =
      page.coverageReasons.map((reason) => reasonNames[reason] ?? reason).join(' ') ||
      'No extraction limitation recorded; absence of a page record is not evidence of absence.';
    return { page, declared, status, limitation };
  });
  // Owner explanations are full-width prose, not a narrow table column. Keep
  // the compact examination summary separate so a long declaration does not
  // create multi-page rows with empty identity/status cells on continuation.
  const rows = entries
    .map(
      ({ page, status, limitation }) =>
        `<tr><td>${esc(pageNames[page.page])}</td><td>${esc(status)}</td><td>${esc(limitation)}</td></tr>`,
    )
    .join('');
  const notes = entries
    .flatMap(({ page, declared, status }) =>
      declared
        ? [
            `<section class="owner-coverage-note" aria-label="Owner explanation: ${esc(pageNames[page.page])}"><h3>${esc(pageNames[page.page])}</h3><p class="owner-coverage-basis">Retained examination: ${esc(status)}.</p><p><strong>${esc(categoryNames[declared.reasonCategory])}</strong></p><p class="owner-coverage-reason">${esc(declared.reason)}</p>${declared.proposedPublicUrl ? `<p class="owner-coverage-follow-up">Proposed follow-up address (not examined by this declaration): ${esc(declared.proposedPublicUrl)}</p>` : ''}</section>`,
          ]
        : [],
    )
    .join('');
  return `<section class="owner-coverage-appendix" aria-label="Owner explanations for incomplete public-page coverage"><style>.owner-coverage-appendix h2,.owner-coverage-note h3{break-after:avoid}.owner-coverage-summary{break-inside:avoid}.owner-coverage-note{width:100%;border-top:1px solid #d9dee5;padding:10px 0;margin-top:12px;break-inside:avoid}.owner-coverage-note p{font-size:9pt;line-height:1.5;orphans:3;widows:3;overflow-wrap:anywhere;word-break:normal}.owner-coverage-note h3{margin:0 0 6px}.owner-coverage-basis{color:#475569}.owner-coverage-reason,.owner-coverage-follow-up{max-width:100%;white-space:normal}</style><h2>Public-page coverage and owner explanations</h2><p>Privacy, contact, terms and consent information are important when consumer data is handled. The summary distinguishes retained examination from missing or incomplete coverage. Missing or blocked public pages require follow-up; an owner explanation does not substitute for examining the page or verifying internal evidence.</p><p><strong>Owner declarations are unverified.</strong> They do not change the original capture, mark a page as examined, establish a control pass, or determine compliance. A partial home-page extraction does not imply that other critical pages were examined.</p><table class="owner-coverage-summary"><thead><tr><th>Public page</th><th>Retained examination</th><th>Extraction limitation</th></tr></thead><tbody>${rows}</tbody></table>${notes}${verified.clarification ? `<p class="brand-facts">Owner declaration revision ${esc(verified.clarification.revisionId)} · actor ${esc(verified.clarification.actorId)} · recorded ${esc(verified.clarification.recordedAt)} · audit receipt ${esc(verified.envelope.owner_clarification!.receipt_id)}.</p><p class="brand-facts">Frozen owner declaration SHA-256 ${esc(verified.envelope.owner_clarification!.snapshot_sha256)}. Later owner declarations do not rewrite this report’s retained source.</p>` : '<p>No owner clarification is required for fully examined pages.</p>'}</section>`;
}
function replaceOnce(html: string, original: string, replacement: string) {
  if (!original || html.split(original).length !== 2) throw Error('clarified_renderer_refused');
  return html.replace(original, () => replacement);
}
function body(html: string) {
  const value = html.match(/<body[^>]*>([\s\S]*)<\/body>/i)?.[1];
  if (!value) throw Error('clarified_renderer_refused');
  return value;
}
type Review = { name: string; actor: string; at: string; hash: string; contentHash: string };
function presentation(input: CoverageFirstBuildInput, review?: Review) {
  const verified = verifyClarifiedSource(input.sourceText, input.sourceSha256, input);
  const document = buildClarifiedReport(input);
  const brandedInput = {
    ...input,
    sourceText: verified.envelope.retained_source.text,
    sourceSha256: verified.envelope.retained_source.sha256,
  };
  let html = renderBrandedDraft(brandedInput);
  const originalDocumentHash = hash(JSON.stringify(buildBrandedReport(brandedInput)));
  html = replaceOnce(
    html,
    `Source SHA-256 ${brandedInput.sourceSha256}`,
    `Source SHA-256 ${input.sourceSha256}`,
  );
  html = replaceOnce(
    html,
    `Document JSON SHA-256 ${originalDocumentHash}`,
    `Document JSON SHA-256 ${review?.contentHash ?? hash(JSON.stringify(document))}`,
  );
  html = replaceOnce(
    html,
    'Template axiom-report-brand-1 · Document 7',
    'Template axiom-report-brand-1 · Document 8',
  );
  if (review) {
    const underlyingInput = {
      ...input,
      sourceText: verified.branded.inner.text,
      sourceSha256: verified.branded.inner.sha256,
    };
    const display = { displayName: review.name, actorId: review.actor, reviewedAt: review.at };
    const originalBody =
      verified.branded.version === 4
        ? body(renderCoverageFirstDocumentPresentation(buildCoverageFirstReport(underlyingInput)))
        : body(
            renderQuestionnaireDocumentPresentation(
              buildQuestionnaireEvidenceReport(underlyingInput),
            ),
          );
    const reviewedBody =
      verified.branded.version === 4
        ? body(
            renderCoverageFirstDocumentPresentation(
              buildCoverageFirstReport(underlyingInput),
              display,
            ),
          )
        : body(
            renderQuestionnaireDocumentPresentation(
              buildQuestionnaireEvidenceReport(underlyingInput),
              display,
            ),
          );
    html = replaceOnce(html, originalBody, reviewedBody);
    html = replaceOnce(
      html,
      'Draft — human review pending; not released',
      'Human-reviewed working report — artifact retention and release are separate',
    );
  }
  const section = html.match(/<section class="brand-review">[\s\S]*?<\/section>/)?.[0];
  if (!section) throw Error('clarified_renderer_refused');
  const approval = review
    ? `<p>Reviewed by ${esc(review.name)} (${esc(review.actor)}) at ${esc(review.at)}.</p><p class="brand-facts">Review SHA-256: ${esc(review.hash)}</p>`
    : '<p>No human approval has been recorded in this draft.</p>';
  html = replaceOnce(
    html,
    section,
    `${appendix(verified)}<section class="brand-review"><h2>Review and custody</h2>${approval}<p>Review is bound to this exact document 8 and its frozen source, including the owner declaration snapshot. Branding and owner declarations do not attest compliance, physical evidence retention or release. Read the actual retained artifact record.</p></section>`,
  );
  return html;
}
export function renderClarifiedDraft(input: CoverageFirstBuildInput) {
  return presentation(input);
}
type ReviewedInput = Omit<CoverageFirstBuildInput, 'generatedAt'> & {
  reportId: string;
  documentText: string;
  documentSha256: string;
  reviewText: string;
  reviewSha256: string;
};
export function renderReviewedClarifiedReport(input: ReviewedInput) {
  try {
    if (
      hash(input.documentText) !== input.documentSha256 ||
      hash(input.reviewText) !== input.reviewSha256
    )
      throw Error();
    const document = ClarifiedDocumentV8Schema.parse(
      parseJson(input.documentText, COVERAGE_FIRST_MAX_BYTES),
    );
    const buildInput = {
      sourceText: input.sourceText,
      sourceSha256: input.sourceSha256,
      requestId: input.requestId,
      tenantId: input.tenantId,
      engagementId: input.engagementId,
      assessmentRunId: input.assessmentRunId,
      title: input.title,
      generatedAt: document.generated_at,
    };
    if (canonicalJson(document) !== canonicalJson(buildClarifiedReport(buildInput))) throw Error();
    const review = z
      .object({
        schema_version: z.literal(1),
        report_id: z.uuid(),
        content_sha256: digest,
        decision: z.literal('approved'),
        reviewer: z.object({ id: z.uuid(), display_name: z.string().min(1).max(200) }).strict(),
        reviewed_at: z.iso.datetime({ offset: true }),
      })
      .strict()
      .parse(parseJson(input.reviewText, 262144));
    if (review.report_id !== input.reportId || review.content_sha256 !== input.documentSha256)
      throw Error();
    return presentation(buildInput, {
      name: review.reviewer.display_name,
      actor: review.reviewer.id,
      at: review.reviewed_at,
      hash: input.reviewSha256,
      contentHash: input.documentSha256,
    });
  } catch {
    throw Error('clarified_review_refused');
  }
}
