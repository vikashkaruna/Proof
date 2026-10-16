import { parseCatalogueJson } from '@axiom/control-library';
/** Verify the exact frozen packet, reviewed draft and human review before PDF rendering. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import {
  FrozenHumanControlReviewSchema,
  verifyFrozenHumanControlReview,
} from './public-control-provenance';
import { BoardReportContentSchema, renderBoardReportHtml } from './board-report';
import {
  interpretAssessmentReport,
  assessmentReviewRecommendation,
} from './assessment-interpretation';

const uuid = z.uuid();
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const timestamp = z.string().refine((value) => Number.isFinite(Date.parse(value)));
const sourceSchema = z.object({
  schema_version: z.literal(1),
  serialization: z.literal('postgres-jsonb-text-v1'),
  kind: z.literal('board_source'),
  request_id: uuid,
  tenant_id: uuid,
  engagement_id: uuid,
  assessment_run_id: uuid,
  library_version: z.string().min(1).max(200),
  controls_text: z.string().min(1),
  controls_sha256: digest,
  result_text: z.string().min(1),
  result_sha256: digest,
  finalized_at: timestamp,
  receipts: z.object({
    started: z.object({ id: z.string().regex(/^[1-9][0-9]*$/), entry_hash: digest }),
    completed: z.object({ id: z.string().regex(/^[1-9][0-9]*$/), entry_hash: digest }),
    finalized: z.object({ id: z.string().regex(/^[1-9][0-9]*$/), entry_hash: digest }),
  }),
});
const sourceV2Schema = sourceSchema
  .extend({
    schema_version: z.literal(2),
    completed_at: timestamp,
    limitations: z.array(z.string().max(2000)).max(10),
    human_control_review: FrozenHumanControlReviewSchema,
  })
  .strict();
export const FrozenBoardSourceSchema = z.discriminatedUnion('schema_version', [
  sourceSchema,
  sourceV2Schema,
]);
const controlSchema = z.object({
  id: z.string().min(1).max(100),
  title: z.string().min(1).max(300),
  domain: z.string().min(1).max(50),
  severity: z.enum(['critical', 'high', 'medium', 'low', 'info']),
  remediation_patterns: z.array(z.string().max(2000)).optional(),
});
const findingSchema = z.object({
  control_id: z.string().min(1).max(100),
  score: z.number().finite().min(0).max(100),
  rationale: z.string().min(1).max(4000),
});
const resultSchema = z.object({
  library_version: z.string().min(1).max(200),
  posture_score: z.number().finite().min(0).max(100),
  estimated_exposure_inr: z.number().int().safe().nonnegative(),
  findings: z.array(findingSchema).min(1).max(500),
});
const reviewSchema = z.object({
  schema_version: z.literal(1),
  report_id: uuid,
  content_sha256: digest,
  decision: z.literal('approved'),
  reviewer: z.object({ id: uuid, display_name: z.string().min(1).max(200) }),
  reviewed_at: timestamp,
});

export interface ReviewedBoardInput {
  sourceText: string;
  sourceSha256: string;
  documentText: string;
  documentSha256: string;
  reviewText: string;
  reviewSha256: string;
  reportId: string;
  requestId: string;
  tenantId: string;
  engagementId: string;
  assessmentRunId: string;
  title: string;
}

function hash(text: string) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
function parseBounded(text: string, maxBytes: number): unknown {
  if (Buffer.byteLength(text, 'utf8') > maxBytes || !text)
    throw new Error('Board source is unbounded');
  return JSON.parse(text) as unknown;
}
function same(value: unknown, expected: unknown) {
  if (value !== expected) throw new Error('Board document differs from frozen source');
}

/** Returns final HTML with the actual immutable review, never a caller-supplied signature. */
export function renderReviewedBoardHtml(input: ReviewedBoardInput): string {
  if (
    hash(input.sourceText) !== input.sourceSha256 ||
    hash(input.documentText) !== input.documentSha256 ||
    hash(input.reviewText) !== input.reviewSha256
  ) {
    throw new Error('Board source or review digest mismatch');
  }
  let sourceRaw = parseBounded(input.sourceText, 4 * 1024 * 1024);
  if ((sourceRaw as Record<string, unknown>)?.schema_version === 2)
    sourceRaw = parseCatalogueJson(input.sourceText, 4 * 1024 * 1024);
  const source = FrozenBoardSourceSchema.parse(sourceRaw);
  if (source.schema_version === 1 && Object.hasOwn(sourceRaw as object, 'human_control_review'))
    throw new Error('Board source provenance downgrade refused');
  const content = BoardReportContentSchema.parse(parseBounded(input.documentText, 5 * 1024 * 1024));
  const review = reviewSchema.parse(parseBounded(input.reviewText, 256 * 1024));
  const controlsValue: unknown = JSON.parse(source.controls_text);
  const resultValue: unknown = JSON.parse(source.result_text);
  const controls = z.array(controlSchema).min(1).max(500).parse(controlsValue);
  const result = resultSchema.parse(resultValue);
  if (
    hash(source.controls_text) !== source.controls_sha256 ||
    hash(source.result_text) !== source.result_sha256
  ) {
    throw new Error('Frozen packet component digest mismatch');
  }
  same(source.request_id, input.requestId);
  same(source.tenant_id, input.tenantId);
  same(source.engagement_id, input.engagementId);
  same(source.assessment_run_id, input.assessmentRunId);
  same(content.tenant_id, input.tenantId);
  same(content.engagement_id, input.engagementId);
  same(content.assessment_run_id, input.assessmentRunId);
  same(content.title, input.title);
  same(content.source_sha256, input.sourceSha256);
  same(content.assessment_result_digest, source.result_sha256);
  same(content.library_digest, source.controls_sha256);
  same(content.library_version, source.library_version);
  same(result.library_version, source.library_version);
  same(review.report_id, input.reportId);
  same(review.content_sha256, input.documentSha256);
  same(content.signatures.approved_by, null);
  same(content.signatures.prepared_by.agent, 'board-report-builder');
  same(content.action_plan.length, 0);

  if ((source.schema_version === 2) !== (content.schema_version === 3))
    throw new Error('Board document provenance downgrade refused');
  if (source.schema_version === 2 && content.schema_version === 3) {
    const appendix = verifyFrozenHumanControlReview(source.human_control_review, {
      tenantId: input.tenantId,
      engagementId: input.engagementId,
      assessmentRunId: input.assessmentRunId,
      libraryVersion: source.library_version,
      controlsText: source.controls_text,
      resultText: source.result_text,
    });
    if (!isDeepStrictEqual(content.public_review_appendix, appendix))
      throw new Error('Board document differs from frozen source');
  }
  const controlsById = new Map(controls.map((item) => [item.id, item]));
  const findingIds = new Set(result.findings.map((item) => item.control_id));
  if (
    controlsById.size !== controls.length ||
    findingIds.size !== controls.length ||
    result.findings.length !== controls.length ||
    [...findingIds].some((id) => !controlsById.has(id)) ||
    content.key_findings.length !== result.findings.length
  ) {
    throw new Error('Board finding register is incomplete');
  }
  // Historical documents cannot discard structured provenance to reintroduce score-as-failure claims.
  if (
    content.schema_version === 1 &&
    Object.hasOwn(resultValue as object, 'questionnaire_provenance')
  )
    throw new Error('Board document provenance downgrade refused');
  const interpreted =
    content.schema_version !== 1
      ? interpretAssessmentReport(resultValue, controlsValue, source.controls_sha256, input.title)
      : null;
  if (content.schema_version !== 1 && interpreted) {
    if (
      !isDeepStrictEqual(content.questionnaire_interpretation, interpreted.interpretation) ||
      !isDeepStrictEqual(content.executive_summary, interpreted.summary)
    )
      throw new Error('Board document differs from frozen source');
  }
  const interpretations = new Map(
    interpreted?.findings.map((finding) => [finding.control_id, finding]),
  );
  result.findings.forEach((finding, index) => {
    const control = controlsById.get(finding.control_id)!;
    const rendered = content.key_findings[index]!;
    same(rendered.control_id, finding.control_id);
    same(rendered.title, control.title);
    same(rendered.domain, control.domain);
    same(rendered.severity, control.severity);
    same(rendered.score, finding.score);
    same(rendered.gap_summary, finding.rationale);
    if (content.schema_version !== 1) {
      const expected = interpretations.get(finding.control_id)!;
      const actual = content.key_findings[index]!;
      for (const key of [
        'display_state',
        'answer_state',
        'applicability_state',
        'answer_counts',
        'score_band',
      ] as const)
        if (!isDeepStrictEqual(actual[key], expected[key]))
          throw new Error('Board document differs from frozen source');
      same(
        actual.remediation_recommendation,
        assessmentReviewRecommendation(expected.display_state, control.remediation_patterns),
      );
    } else {
      // Preserve V1 source and document bytes; do not silently reinterpret historical drafts.
      findingSchema.extend({ rationale: z.string().min(1).max(2000) }).parse(finding);
      same(
        rendered.remediation_recommendation,
        control.remediation_patterns?.[0] ||
          'No remediation pattern is recorded in the frozen control library.',
      );
    }
  });

  if (content.schema_version === 1) {
    const summary = content.executive_summary;
    same(summary.posture_score, result.posture_score);
    same(summary.estimated_exposure_inr, result.estimated_exposure_inr);
    same(summary.total_controls, controls.length);
    const passed = result.findings.filter((item) => item.score >= 80).length;
    same(summary.passed_controls, passed);
    same(summary.failed_controls, controls.length - passed);
    for (const [severity, key] of [
      ['critical', 'critical_gaps'],
      ['high', 'high_gaps'],
      ['medium', 'medium_gaps'],
      ['low', 'low_gaps'],
    ] as const) {
      same(
        summary[key],
        result.findings.filter(
          (item) => item.score < 80 && controlsById.get(item.control_id)?.severity === severity,
        ).length,
      );
    }
    same(
      summary.narrative,
      `This report summarizes the recorded assessment for ${input.title}. The computed posture score is ${result.posture_score}%. Evidence requirements in the control library do not establish that evidence was collected or independently verified.`,
    );
  }
  return renderBoardReportHtml({
    ...content,
    signatures: {
      ...content.signatures,
      approved_by: {
        user_id: review.reviewer.id,
        name: review.reviewer.display_name,
        role: 'Axiom internal founder reviewer',
        timestamp: new Date(review.reviewed_at).toISOString(),
        review_sha256: input.reviewSha256,
      },
    },
  });
}
