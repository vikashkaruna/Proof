import { ApprovedLibraryVersionSchema } from '@axiom/types';
/** Pure unmounted document5. No score, exposure or compliance conclusion is
 * inferred from public evidence or unverified declarations. */
import { canonicalJson } from '@axiom/ledger';
import { z } from 'zod';
import {
  PublicControlReportAppendixSchema,
  PublicWebsiteAssetScopeSchema,
} from './public-control-provenance';
import {
  parseCoverageFirstJson,
  CoverageFirstPolicySchema,
  CoverageFirstScopeSchema,
  COVERAGE_FIRST_MAX_BYTES,
  coverageFirstHash,
  verifyCoverageFirstSource,
} from './coverage-first-source';
const uuid = z.uuid(),
  digest = z.string().regex(/^[a-f0-9]{64}$/);
const count = z.number().int().min(0).max(100000);
const questionSchema = z
  .object({
    questionId: z.string().min(1).max(200),
    prompt: z.string().min(1).max(10000),
    state: z.enum([
      'omitted_unknown',
      'explicit_unknown',
      'human_yes_unverified',
      'human_no_unverified',
      'not_boolean_assessable',
    ]),
    rationale: z.string().max(8000).nullable(),
    availableCandidateOrdinals: z.array(z.number().int().min(1).max(128)).max(128),
    citedCandidateOrdinals: z.array(z.number().int().min(1).max(128)).max(128),
  })
  .strict();
const appendix = PublicControlReportAppendixSchema.shape;
export const CoverageFirstDocumentV5Schema = z
  .object({
    schema_version: z.literal(5),
    kind: z.enum(['board_report', 'auditor_pack']),
    request_id: uuid,
    tenant_id: uuid,
    engagement_id: uuid,
    assessment_run_id: uuid,
    title: z.string().min(1).max(300),
    generated_at: z.iso.datetime({ offset: true }),
    source_sha256: digest,
    retained_source_sha256: digest,
    assessment_result_digest: digest,
    library_digest: digest,
    presentation_policy: CoverageFirstPolicySchema,
    metrics: z
      .object({ state: z.literal('withheld'), compliance_conclusion: z.literal('not_determined') })
      .strict(),
    coverage: z
      .object({
        pages: appendix.pages,
        pageSources: appendix.pageSources,
        candidatesTruncated: z.boolean(),
        wholeWebsiteExamined: z.literal(false),
        internalEvidenceVerified: z.literal(false),
      })
      .strict(),
    summary: z
      .object({
        controls: count,
        questions: count,
        omittedUnknown: count,
        explicitUnknown: count,
        humanYesUnverified: count,
        humanNoUnverified: count,
        notBooleanAssessable: count,
      })
      .strict(),
    applicability: appendix.applicability,
    candidates: appendix.publicCandidates,
    controls: z
      .array(
        z
          .object({
            controlId: z.string().min(1).max(200),
            title: z.string().min(1).max(2000),
            questions: z.array(questionSchema).max(1000),
            evidenceRequirements: appendix.controls.element.shape.evidenceRequirements,
          })
          .strict(),
      )
      .max(500),
    provenance: z
      .object({
        libraryVersion: ApprovedLibraryVersionSchema,
        reviewId: uuid,
        reviewActorId: uuid,
        reviewedAt: z.iso.datetime({ offset: true }),
        captureCheckedAt: z.iso.datetime({ offset: true }),
        capturePayloadSha256: digest,
        reviewRequestSha256: digest,
        reviewSnapshotSha256: digest,
        captureReceipt: appendix.captureReceipt,
        reviewReceipt: appendix.reviewReceipt,
        requestedReceipt: appendix.requestedReceipt,
      })
      .strict(),
    asset_scope: PublicWebsiteAssetScopeSchema.nullable(),
    declarationsVerified: z.literal(false),
    evidenceVerified: z.literal(false),
    humanReviewRequired: z.literal(true),
  })
  .strict();
export type CoverageFirstDocumentV5 = z.infer<typeof CoverageFirstDocumentV5Schema>;
const buildInputSchema = CoverageFirstScopeSchema.extend({
  sourceText: z.string().min(1),
  sourceSha256: digest,
  title: z.string().min(1).max(300),
  generatedAt: z.iso.datetime({ offset: true }),
}).strict();
export type CoverageFirstBuildInput = z.infer<typeof buildInputSchema>;

/** Future caller must bind scope/title to its authenticated, immutable request row. */
export function buildCoverageFirstReport(raw: CoverageFirstBuildInput): CoverageFirstDocumentV5 {
  try {
    const input = buildInputSchema.parse(raw);
    const scope = {
      requestId: input.requestId,
      tenantId: input.tenantId,
      engagementId: input.engagementId,
      assessmentRunId: input.assessmentRunId,
    };
    const frozen = verifyCoverageFirstSource(input.sourceText, input.sourceSha256, scope);
    const value = frozen.public_review_appendix;
    const controls = value.controls.map((c) => ({
      controlId: c.controlId,
      title: c.title,
      evidenceRequirements: c.evidenceRequirements,
      questions: c.questions.map((q) => ({
        questionId: q.questionId,
        prompt: q.prompt,
        state:
          q.type !== 'boolean'
            ? 'not_boolean_assessable'
            : q.judgment === 'omitted'
              ? 'omitted_unknown'
              : q.answer === null
                ? 'explicit_unknown'
                : q.answer
                  ? 'human_yes_unverified'
                  : 'human_no_unverified',
        rationale: q.rationale,
        availableCandidateOrdinals: q.availableCandidateOrdinals,
        citedCandidateOrdinals: q.candidates.map((c) => c.ordinal),
      })),
    }));
    const questions = controls.flatMap((c) => c.questions);
    const stateCount = (state: string) => questions.filter((q) => q.state === state).length;
    const document = CoverageFirstDocumentV5Schema.parse({
      schema_version: 5,
      kind: frozen.envelope.report_kind === 'board' ? 'board_report' : 'auditor_pack',
      request_id: input.requestId,
      tenant_id: input.tenantId,
      engagement_id: input.engagementId,
      assessment_run_id: input.assessmentRunId,
      title: input.title,
      generated_at: input.generatedAt,
      source_sha256: input.sourceSha256,
      retained_source_sha256: frozen.envelope.retained_source.sha256,
      assessment_result_digest: frozen.source.result_sha256,
      library_digest: frozen.source.controls_sha256,
      presentation_policy: frozen.envelope.presentation_policy,
      metrics: { state: 'withheld', compliance_conclusion: 'not_determined' },
      coverage: {
        pages: value.pages,
        pageSources: value.pageSources,
        candidatesTruncated: value.candidatesTruncated,
        wholeWebsiteExamined: false,
        internalEvidenceVerified: false,
      },
      summary: {
        controls: controls.length,
        questions: questions.length,
        omittedUnknown: stateCount('omitted_unknown'),
        explicitUnknown: stateCount('explicit_unknown'),
        humanYesUnverified: stateCount('human_yes_unverified'),
        humanNoUnverified: stateCount('human_no_unverified'),
        notBooleanAssessable: stateCount('not_boolean_assessable'),
      },
      applicability: value.applicability,
      candidates: value.publicCandidates,
      controls,
      provenance: {
        libraryVersion: value.catalogue.library_version,
        reviewId: value.reviewId,
        reviewActorId: value.reviewActorId,
        reviewedAt: value.reviewedAt,
        captureCheckedAt: value.captureCheckedAt,
        capturePayloadSha256: value.capturePayloadSha256,
        reviewRequestSha256: value.reviewRequestSha256,
        reviewSnapshotSha256: value.reviewSnapshotSha256,
        captureReceipt: value.captureReceipt,
        reviewReceipt: value.reviewReceipt,
        requestedReceipt: value.requestedReceipt,
      },
      asset_scope: frozen.asset_scope,
      declarationsVerified: false,
      evidenceVerified: false,
      humanReviewRequired: true,
    });
    parseCoverageFirstJson(canonicalJson(document), COVERAGE_FIRST_MAX_BYTES);
    return document;
  } catch {
    throw Error('coverage_document_refused');
  }
}
const escape = (v: string) =>
  v
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
const stateLabels: Record<
  CoverageFirstDocumentV5['controls'][number]['questions'][number]['state'],
  string
> = {
  omitted_unknown: 'Omitted judgment — Unknown',
  explicit_unknown: 'Explicit Unknown',
  human_yes_unverified: 'Human declaration: Yes — unverified',
  human_no_unverified: 'Human declaration: No — unverified',
  not_boolean_assessable: 'Requires supported internal evidence workflow',
};
function html(
  document: CoverageFirstDocumentV5,
  review?: { displayName: string; actorId: string; reviewedAt: string },
) {
  const d = document;
  const identity = review ? 'Human-reviewed evidence report' : 'Draft for human review';
  const scope = d.asset_scope;
  const asset = scope
    ? '<p>Human-declared asset scope: estate ' +
      escape(scope.estate.name) +
      '; system ' +
      escape(scope.system.name) +
      '; public URL ' +
      escape(scope.target.url) +
      '. Ownership is not verified. Connector access is not granted.</p>'
    : '<p>Estate context comes from the reviewed engagement. No retained system or registered connector association establishes website ownership or access.</p>';
  const pages = d.coverage.pages
    .map(
      (p) =>
        '<tr><td>' +
        escape(p.page) +
        '</td><td>' +
        escape(p.state) +
        '</td><td>' +
        (p.state !== 'examined'
          ? 'No examined public evidence retained'
          : p.truncated
            ? 'Partial: ' + escape(p.coverageReasons.join(', '))
            : 'No recorded extraction truncation') +
        '</td></tr>',
    )
    .join('');
  const register = d.controls
    .map(
      (c) =>
        '<tr><td>' +
        escape(c.controlId) +
        '<br>' +
        escape(c.title) +
        '</td><td>' +
        c.questions
          .map(
            (q) =>
              '<p>' +
              escape(q.questionId) +
              ': ' +
              escape(q.prompt) +
              '<br><strong>' +
              escape(stateLabels[q.state]) +
              '</strong>' +
              (q.rationale
                ? '<br>Human rationale: ' + escape(q.rationale)
                : '<br>No human rationale recorded.') +
              '<br>Available public signals: ' +
              (q.availableCandidateOrdinals.join(', ') || 'none mapped') +
              '; explicitly cited: ' +
              (q.citedCandidateOrdinals.join(', ') || 'none') +
              '.</p>',
          )
          .join('') +
        '</td><td>' +
        c.evidenceRequirements
          .map(
            (r) =>
              '<p>' + escape(r.requirement.description) + ' — internal verification required.</p>',
          )
          .join('') +
        '</td></tr>',
    )
    .join('');
  // Each retained excerpt appears once; controls reference stable source ordinals.
  const candidates = d.candidates
    .map(
      (c) =>
        '<article><h3>Candidate ' +
        c.ordinal +
        ' · ' +
        escape(c.locator.page) +
        '</h3><p>' +
        escape(c.kind) +
        ' · ' +
        escape(c.facet) +
        ' · context: ' +
        escape(c.context) +
        '. Qualified public signal, not a verified mechanism.</p><blockquote>' +
        escape(c.excerpt) +
        '</blockquote><p class="provenance">Body SHA-256 ' +
        c.locator.contentSha256 +
        '</p></article>',
    )
    .join('');
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>' +
    escape(d.title) +
    '</title><style>@page{size:A4;margin:16mm}body{font:12px/1.5 Arial,sans-serif;color:#1e2a4a}h1{font-size:22px}aside{background:#f1f5f9;border-left:4px solid #d9534f;padding:12px}table{width:100%;border-collapse:collapse;table-layout:fixed}th,td{border:1px solid #cbd5e1;padding:7px;text-align:left;vertical-align:top;overflow-wrap:anywhere}blockquote{margin:8px 0;padding-left:12px;border-left:2px solid #cbd5e1}.provenance{font-size:10px;overflow-wrap:anywhere}tr,article{break-inside:avoid}</style></head><body><header><p>' +
    identity +
    '</p><h1>' +
    escape(d.title) +
    '</h1><p>Axiom Proof · ' +
    (d.kind === 'board_report' ? 'Board evidence review' : 'Auditor evidence review') +
    '</p></header><aside>Scores and financial exposure estimates are withheld. Public website evidence and unverified human declarations do not establish internal implementation, statutory breach, independent audit or compliance certification.</aside>' +
    '<h2>Scope and coverage</h2>' +
    asset +
    '<p>Bounded public HTML capture only. No whole-site crawl; JavaScript behavior, private systems and internal evidence are not verified. ' +
    (d.coverage.candidatesTruncated
      ? 'Candidate limit reached; additional signals may remain.'
      : 'No recorded candidate-limit truncation.') +
    '</p><table><thead><tr><th>Page</th><th>Capture state</th><th>Coverage qualification</th></tr></thead><tbody>' +
    pages +
    '</tbody></table><p>Zero forms does not mean a page or privacy notice is missing. Unavailable or unexamined pages do not establish absence.</p>' +
    '<h2>Review coverage and evidence needed</h2><p>' +
    d.summary.controls +
    ' controls; ' +
    d.summary.questions +
    ' questions. Omitted judgments: ' +
    d.summary.omittedUnknown +
    '; explicit Unknown: ' +
    d.summary.explicitUnknown +
    '; unverified Yes: ' +
    d.summary.humanYesUnverified +
    '; unverified No: ' +
    d.summary.humanNoUnverified +
    '; supported internal workflow required: ' +
    d.summary.notBooleanAssessable +
    '.</p><p>Applicability declarations remain unverified: significant-data-fiduciary ' +
    (d.applicability.sdfSelfAttested === null
      ? 'Unknown'
      : String(d.applicability.sdfSelfAttested)) +
    '; children ' +
    (d.applicability.processesChildren === null
      ? 'Unknown'
      : String(d.applicability.processesChildren)) +
    '; health ' +
    (d.applicability.processesHealth === null
      ? 'Unknown'
      : String(d.applicability.processesHealth)) +
    '. Rationale: ' +
    escape(d.applicability.rationale) +
    '</p><p>A human No is a reported gap requiring verification; omitted and Unknown answers are not failed controls. Review statutory applicability and effective dates with qualified legal advice.</p>' +
    '<table><thead><tr><th>Control</th><th>Qualified findings</th><th>Proof still needed</th></tr></thead><tbody>' +
    register +
    '</tbody></table><h2>Source excerpts, retained once</h2>' +
    candidates +
    (review
      ? '<h2>Recorded human content review</h2><p>' +
        escape(review.displayName) +
        ' · ' +
        escape(review.actorId) +
        ' · ' +
        escape(review.reviewedAt) +
        '. This content review does not itself establish artifact release.</p>'
      : '<p>No report-content approval is asserted by this draft.</p>') +
    '<footer class="provenance">Request ' +
    d.request_id +
    ' · assessment run ' +
    d.assessment_run_id +
    ' · source SHA-256 ' +
    d.source_sha256 +
    ' · retained source SHA-256 ' +
    d.retained_source_sha256 +
    ' · review ' +
    d.provenance.reviewId +
    ' · capture payload SHA-256 ' +
    d.provenance.capturePayloadSha256 +
    ' · catalogue ' +
    d.provenance.libraryVersion +
    '. Original assessment computations remain opaque provenance; no estimate is endorsed by this report.</footer></body></html>'
  );
}
/** Recompute against exact source, rather than rendering a plausible grafted document. */
export function renderCoverageFirstDraft(input: CoverageFirstBuildInput) {
  return html(buildCoverageFirstReport(input));
}
const reviewedInputSchema = buildInputSchema
  .omit({ generatedAt: true })
  .extend({
    reportId: uuid,
    documentText: z.string().min(1),
    documentSha256: digest,
    reviewText: z.string().min(1),
    reviewSha256: digest,
  })
  .strict();
export function renderReviewedCoverageFirstReport(raw: z.infer<typeof reviewedInputSchema>) {
  try {
    const input = reviewedInputSchema.parse(raw);
    if (
      coverageFirstHash(input.documentText) !== input.documentSha256 ||
      coverageFirstHash(input.reviewText) !== input.reviewSha256
    )
      throw Error();
    const document = CoverageFirstDocumentV5Schema.parse(
      parseCoverageFirstJson(input.documentText, COVERAGE_FIRST_MAX_BYTES),
    );
    const expected = buildCoverageFirstReport({
      requestId: input.requestId,
      tenantId: input.tenantId,
      engagementId: input.engagementId,
      assessmentRunId: input.assessmentRunId,
      title: input.title,
      sourceText: input.sourceText,
      sourceSha256: input.sourceSha256,
      generatedAt: document.generated_at,
    });
    if (canonicalJson(document) !== canonicalJson(expected)) throw Error();
    const review = z
      .object({
        schema_version: z.literal(1),
        report_id: uuid,
        content_sha256: digest,
        decision: z.literal('approved'),
        reviewer: z.object({ id: uuid, display_name: z.string().min(1).max(200) }).strict(),
        reviewed_at: z.iso.datetime({ offset: true }),
      })
      .strict()
      .parse(parseCoverageFirstJson(input.reviewText, 262144));
    if (review.report_id !== input.reportId || review.content_sha256 !== input.documentSha256)
      throw Error();
    return html(document, {
      displayName: review.reviewer.display_name,
      actorId: review.reviewer.id,
      reviewedAt: review.reviewed_at,
    });
  } catch {
    throw Error('coverage_review_refused');
  }
}
