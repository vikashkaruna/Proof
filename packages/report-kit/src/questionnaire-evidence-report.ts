/** Source5/document6: NEW Board/Auditor requests over a questionnaire-only
 * assessment (frozen source1, no retained public-control review) withhold
 * posture, exposure and score bands (owner decision e438/e439). The frozen
 * original result stays opaque provenance; nothing numeric is projected.
 *
 * Every field below is copied verbatim from the frozen source or is a fixed
 * literal, so SQL (0155) recomputes the identical canonical document. */
import { canonicalJson } from '@axiom/ledger';
import { validateQuestionnaireProvenance } from '@axiom/types';
import { z } from 'zod';
import { FrozenBoardSourceSchema } from './board-source';
import { FrozenAuditorSourceSchema } from './auditor-source';
import {
  COVERAGE_FIRST_MAX_BYTES as MAX_BYTES,
  coverageFirstHash as sha256,
  parseCoverageFirstJson as parseJson,
} from './coverage-first-source';

export const QUESTIONNAIRE_EVIDENCE_SOURCE_CODEC =
  'axiom-questionnaire-evidence-source-canonical-json-1';
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const uuid = z.uuid();
const boundedText = z
  .string()
  .min(1)
  .refine((v) => Buffer.byteLength(v, 'utf8') <= MAX_BYTES);
const reasons = [
  'questionnaire_declarations_unverified',
  'independent_evidence_not_verified',
  'applicability_unverified',
] as const;

/** Fixed policy: answering every question never unlocks a metric. */
export const QuestionnaireEvidencePolicySchema = z
  .object({
    version: z.literal(2),
    document_version: z.literal(6),
    evidence_basis: z.literal('unverified_questionnaire_declarations'),
    metrics: z.literal('withheld'),
    reasons: z.tuple([z.literal(reasons[0]), z.literal(reasons[1]), z.literal(reasons[2])]),
    review_required: z.literal(true),
  })
  .strict();
export function questionnaireEvidencePolicy() {
  return QuestionnaireEvidencePolicySchema.parse({
    version: 2,
    document_version: 6,
    evidence_basis: 'unverified_questionnaire_declarations',
    metrics: 'withheld',
    reasons: [...reasons],
    review_required: true,
  });
}

export const QuestionnaireEvidenceSourceV5Schema = z
  .object({
    schema_version: z.literal(5),
    serialization: z.literal(QUESTIONNAIRE_EVIDENCE_SOURCE_CODEC),
    kind: z.literal('questionnaire_evidence_report_source'),
    report_kind: z.enum(['board', 'auditor']),
    presentation_policy: QuestionnaireEvidencePolicySchema,
    retained_source: z
      .object({
        serialization: z.literal('postgres-jsonb-text-v1'),
        schema_version: z.literal(1),
        text: boundedText,
        sha256: digest,
      })
      .strict(),
  })
  .strict();
export const QuestionnaireEvidenceScopeSchema = z
  .object({ requestId: uuid, tenantId: uuid, engagementId: uuid, assessmentRunId: uuid })
  .strict();
export type QuestionnaireEvidenceScope = z.infer<typeof QuestionnaireEvidenceScopeSchema>;

function readRetained(value: z.infer<typeof QuestionnaireEvidenceSourceV5Schema>) {
  const original = value.retained_source;
  if (sha256(original.text) !== original.sha256) throw Error();
  const raw = parseJson(original.text, MAX_BYTES);
  const source =
    value.report_kind === 'board'
      ? FrozenBoardSourceSchema.parse(raw)
      : FrozenAuditorSourceSchema.parse(raw);
  // Only a questionnaire-only source1 qualifies; reviewed public sources use source4.
  if (source.schema_version !== 1) throw Error();
  if (
    sha256(source.controls_text) !== source.controls_sha256 ||
    sha256(source.result_text) !== source.result_sha256
  )
    throw Error();
  const controls = z
    .array(
      z
        .object({
          id: z.string().min(1).max(200),
          title: z.string().min(1).max(2000),
          domain: z.string().min(1).max(50),
        })
        .passthrough(),
    )
    .min(1)
    .max(500)
    .parse(parseJson(source.controls_text, MAX_BYTES));
  const result = parseJson(source.result_text, MAX_BYTES);
  const provenance = validateQuestionnaireProvenance(
    result,
    controls,
    source.controls_sha256,
  ).provenance;
  return { source, controls, provenance };
}

/** For a NEW request only; never upgrades an existing request in place. */
export function encodeQuestionnaireEvidenceSource(
  reportKind: 'board' | 'auditor',
  retainedText: string,
  retainedSha256: string,
) {
  try {
    const value = QuestionnaireEvidenceSourceV5Schema.parse({
      schema_version: 5,
      serialization: QUESTIONNAIRE_EVIDENCE_SOURCE_CODEC,
      kind: 'questionnaire_evidence_report_source',
      report_kind: reportKind,
      presentation_policy: questionnaireEvidencePolicy(),
      retained_source: {
        serialization: 'postgres-jsonb-text-v1',
        schema_version: 1,
        text: retainedText,
        sha256: retainedSha256,
      },
    });
    readRetained(value);
    const text = canonicalJson(value);
    parseJson(text, MAX_BYTES);
    return { text, sha256: sha256(text) };
  } catch {
    throw Error('questionnaire_source_refused');
  }
}

export function verifyQuestionnaireEvidenceSource(
  text: string,
  sourceSha256: string,
  trustedScope: QuestionnaireEvidenceScope,
) {
  try {
    const scope = QuestionnaireEvidenceScopeSchema.parse(trustedScope);
    if (!digest.safeParse(sourceSha256).success || sha256(text) !== sourceSha256) throw Error();
    const envelope = QuestionnaireEvidenceSourceV5Schema.parse(parseJson(text, MAX_BYTES));
    if (canonicalJson(envelope) !== text) throw Error();
    const verified = readRetained(envelope);
    if (
      verified.source.request_id !== scope.requestId ||
      verified.source.tenant_id !== scope.tenantId ||
      verified.source.engagement_id !== scope.engagementId ||
      verified.source.assessment_run_id !== scope.assessmentRunId
    )
      throw Error();
    return { envelope, ...verified };
  } catch {
    throw Error('questionnaire_source_refused');
  }
}

const STATES = [
  'provenance_unavailable',
  'unknown',
  'declared_not_applicable_unverified',
  'not_boolean_assessable',
  'declarations_recorded_unverified',
] as const;
type ControlState = (typeof STATES)[number];
/** Fixed qualitative guidance; no recorded remediation pattern or score is used. */
export const QUESTIONNAIRE_EVIDENCE_NEEDED: Record<ControlState, string> = {
  provenance_unavailable:
    'Questionnaire provenance is unavailable; review the source questionnaire and applicability.',
  unknown:
    'Answer the open questionnaire declarations and confirm applicability, then provide supporting evidence.',
  declared_not_applicable_unverified:
    'Provide evidence supporting the declaration that this control does not apply.',
  not_boolean_assessable:
    'Collect supporting evidence; this control has no questionnaire declaration to record.',
  declarations_recorded_unverified:
    'Provide evidence supporting the recorded declarations; they are not verified.',
};
const count = z.number().int().min(0).max(100000);
const receipt = z.object({ id: z.string().regex(/^[1-9][0-9]*$/), entry_hash: digest }).strict();

export const QuestionnaireEvidenceDocumentV6Schema = z
  .object({
    schema_version: z.literal(6),
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
    presentation_policy: QuestionnaireEvidencePolicySchema,
    metrics: z
      .object({ state: z.literal('withheld'), compliance_conclusion: z.literal('not_determined') })
      .strict(),
    questionnaire: z
      .object({
        provenance: z.enum(['caller_declared_unverified', 'unavailable']),
        libraryVersion: z.string().min(1).max(200),
      })
      .strict(),
    applicability: z
      .object({
        sdfSelfAttested: z.boolean().nullable(),
        processesChildren: z.boolean().nullable(),
        processesHealth: z.boolean().nullable(),
      })
      .strict()
      .nullable(),
    summary: z
      .object({
        controls: count,
        provenanceUnavailable: count,
        unknown: count,
        declaredNotApplicable: count,
        notBooleanAssessable: count,
        declarationsRecorded: count,
      })
      .strict(),
    controls: z
      .array(
        z
          .object({
            controlId: z.string().min(1).max(200),
            title: z.string().min(1).max(2000),
            domain: z.string().min(1).max(50),
            state: z.enum(STATES),
            answerState: z
              .enum([
                'unknown',
                'partially_answered',
                'caller_declared_unverified',
                'not_boolean_assessable',
              ])
              .nullable(),
            applicabilityState: z
              .enum([
                'unconditional',
                'unknown',
                'caller_declared_applicable_unverified',
                'caller_declared_not_applicable_unverified',
              ])
              .nullable(),
            answerCounts: z
              .object({ known: count, affirmed: count, denied: count, unknown: count })
              .strict()
              .nullable(),
            evidenceNeeded: z.string().min(1).max(500),
          })
          .strict(),
      )
      .min(1)
      .max(500),
    provenance: z
      .object({
        finalizedAt: z.string().min(1).max(100),
        finalizedReceipt: receipt,
      })
      .strict(),
    declarationsVerified: z.literal(false),
    evidenceVerified: z.literal(false),
    humanReviewRequired: z.literal(true),
  })
  .strict();
export type QuestionnaireEvidenceDocumentV6 = z.infer<typeof QuestionnaireEvidenceDocumentV6Schema>;

const buildInputSchema = QuestionnaireEvidenceScopeSchema.extend({
  sourceText: z.string().min(1),
  sourceSha256: digest,
  title: z.string().min(1).max(300),
  generatedAt: z.iso.datetime({ offset: true }),
}).strict();
export type QuestionnaireEvidenceBuildInput = z.infer<typeof buildInputSchema>;

export function buildQuestionnaireEvidenceReport(
  raw: QuestionnaireEvidenceBuildInput,
): QuestionnaireEvidenceDocumentV6 {
  try {
    const input = buildInputSchema.parse(raw);
    const frozen = verifyQuestionnaireEvidenceSource(input.sourceText, input.sourceSha256, {
      requestId: input.requestId,
      tenantId: input.tenantId,
      engagementId: input.engagementId,
      assessmentRunId: input.assessmentRunId,
    });
    const p = frozen.provenance;
    const declaredById = new Map(p?.controls.map((c) => [c.control_id, c]));
    const controls = frozen.controls.map((control) => {
      const d = declaredById.get(control.id);
      const state: ControlState = !d
        ? 'provenance_unavailable'
        : d.applicability_state === 'caller_declared_not_applicable_unverified'
          ? 'declared_not_applicable_unverified'
          : d.applicability_state === 'unknown' ||
              d.answer_state === 'unknown' ||
              d.answer_state === 'partially_answered'
            ? 'unknown'
            : d.answer_state === 'not_boolean_assessable'
              ? 'not_boolean_assessable'
              : 'declarations_recorded_unverified';
      return {
        controlId: control.id,
        title: control.title,
        domain: control.domain,
        state,
        answerState: d?.answer_state ?? null,
        applicabilityState: d?.applicability_state ?? null,
        answerCounts: d
          ? {
              known: d.known_boolean_question_count,
              affirmed: d.caller_affirmed_count,
              denied: d.caller_denied_count,
              unknown: d.unknown_count,
            }
          : null,
        evidenceNeeded: QUESTIONNAIRE_EVIDENCE_NEEDED[state],
      };
    });
    const n = (s: ControlState) => controls.filter((c) => c.state === s).length;
    const document = QuestionnaireEvidenceDocumentV6Schema.parse({
      schema_version: 6,
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
      questionnaire: {
        provenance: p ? 'caller_declared_unverified' : 'unavailable',
        libraryVersion: frozen.source.library_version,
      },
      applicability: p
        ? {
            sdfSelfAttested: p.applicability.sdf_self_attested.value,
            processesChildren: p.applicability.processes_children.value,
            processesHealth: p.applicability.processes_health.value,
          }
        : null,
      summary: {
        controls: controls.length,
        provenanceUnavailable: n('provenance_unavailable'),
        unknown: n('unknown'),
        declaredNotApplicable: n('declared_not_applicable_unverified'),
        notBooleanAssessable: n('not_boolean_assessable'),
        declarationsRecorded: n('declarations_recorded_unverified'),
      },
      controls,
      provenance: {
        finalizedAt: frozen.source.finalized_at,
        finalizedReceipt: {
          id: frozen.source.receipts.finalized.id,
          entry_hash: frozen.source.receipts.finalized.entry_hash,
        },
      },
      declarationsVerified: false,
      evidenceVerified: false,
      humanReviewRequired: true,
    });
    parseJson(canonicalJson(document), MAX_BYTES);
    return document;
  } catch {
    throw Error('questionnaire_document_refused');
  }
}

const escape = (v: string) =>
  v
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
const stateLabels: Record<ControlState, string> = {
  provenance_unavailable: 'Questionnaire provenance unavailable',
  unknown: 'Unknown — declarations or applicability open',
  declared_not_applicable_unverified: 'Declared not applicable — unverified',
  not_boolean_assessable: 'Requires supported evidence workflow',
  declarations_recorded_unverified: 'Declarations recorded — unverified',
};
const tri = (v: boolean | null) =>
  v === null ? 'Unknown' : v ? 'Yes (declared)' : 'No (declared)';

function html(
  d: QuestionnaireEvidenceDocumentV6,
  review?: { displayName: string; actorId: string; reviewedAt: string },
) {
  const identity = review ? 'Human-reviewed evidence report' : 'Draft for human review';
  const register = d.controls
    .map(
      (c) =>
        '<tr><td>' +
        escape(c.controlId) +
        '<br>' +
        escape(c.title) +
        '</td><td><strong>' +
        escape(stateLabels[c.state]) +
        '</strong>' +
        (c.answerCounts
          ? '<br>Declarations: ' +
            c.answerCounts.affirmed +
            ' Yes, ' +
            c.answerCounts.denied +
            ' No, ' +
            c.answerCounts.unknown +
            ' Unknown of ' +
            c.answerCounts.known +
            ' questions (unverified).'
          : '') +
        '</td><td>' +
        escape(c.evidenceNeeded) +
        '</td></tr>',
    )
    .join('');
  const s = d.summary;
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>' +
    escape(d.title) +
    '</title><style>@page{size:A4;margin:16mm}body{font:12px/1.5 Arial,sans-serif;color:#1e2a4a}h1{font-size:22px}aside{background:#f1f5f9;border-left:4px solid #d9534f;padding:12px}table{width:100%;border-collapse:collapse;table-layout:fixed}th,td{border:1px solid #cbd5e1;padding:7px;text-align:left;vertical-align:top;overflow-wrap:anywhere}.provenance{font-size:10px;overflow-wrap:anywhere}tr{break-inside:avoid}</style></head><body><header><p>' +
    identity +
    '</p><h1>' +
    escape(d.title) +
    '</h1><p>Axiom Proof · ' +
    (d.kind === 'board_report' ? 'Board evidence review' : 'Auditor evidence review') +
    '</p></header><aside>Scores, score bands and financial exposure estimates are withheld. Unverified questionnaire declarations do not establish implementation, applicability, statutory breach, independent audit or compliance certification.</aside>' +
    '<h2>Basis</h2><p>Questionnaire declarations only (' +
    (d.questionnaire.provenance === 'unavailable'
      ? 'questionnaire provenance unavailable for this run'
      : 'recorded, unverified') +
    '); catalogue ' +
    escape(d.questionnaire.libraryVersion) +
    '. No public website or internal evidence was examined.</p>' +
    '<h2>Applicability declarations</h2><p>' +
    (d.applicability
      ? 'Significant data fiduciary: ' +
        tri(d.applicability.sdfSelfAttested) +
        '; children: ' +
        tri(d.applicability.processesChildren) +
        '; health: ' +
        tri(d.applicability.processesHealth) +
        '. All unverified.'
      : 'Unavailable for this run.') +
    ' Review statutory applicability and effective dates with qualified legal advice.</p>' +
    '<h2>Coverage and evidence needed</h2><p>' +
    s.controls +
    ' controls. Declarations recorded (unverified): ' +
    s.declarationsRecorded +
    '; Unknown: ' +
    s.unknown +
    '; declared not applicable: ' +
    s.declaredNotApplicable +
    '; evidence workflow required: ' +
    s.notBooleanAssessable +
    '; provenance unavailable: ' +
    s.provenanceUnavailable +
    '.</p><p>A declared No is a reported gap requiring verification; Unknown answers are not failed controls.</p>' +
    '<table><thead><tr><th>Control</th><th>Qualified state</th><th>Proof still needed</th></tr></thead><tbody>' +
    register +
    '</tbody></table>' +
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
    ' · finalized ' +
    escape(d.provenance.finalizedAt) +
    ' · finalized receipt ' +
    d.provenance.finalizedReceipt.id +
    '. Original assessment computations remain opaque provenance; no estimate is endorsed by this report.</footer></body></html>'
  );
}

export function renderQuestionnaireEvidenceDraft(input: QuestionnaireEvidenceBuildInput) {
  return html(buildQuestionnaireEvidenceReport(input));
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
export function renderReviewedQuestionnaireEvidenceReport(
  raw: z.infer<typeof reviewedInputSchema>,
) {
  try {
    const input = reviewedInputSchema.parse(raw);
    if (
      sha256(input.documentText) !== input.documentSha256 ||
      sha256(input.reviewText) !== input.reviewSha256
    )
      throw Error();
    const document = QuestionnaireEvidenceDocumentV6Schema.parse(
      parseJson(input.documentText, MAX_BYTES),
    );
    const expected = buildQuestionnaireEvidenceReport({
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
      .parse(parseJson(input.reviewText, 262144));
    if (review.report_id !== input.reportId || review.content_sha256 !== input.documentSha256)
      throw Error();
    return html(document, {
      displayName: review.reviewer.display_name,
      actorId: review.reviewer.id,
      reviewedAt: review.reviewed_at,
    });
  } catch {
    throw Error('questionnaire_review_refused');
  }
}
