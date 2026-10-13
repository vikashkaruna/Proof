import { z } from 'zod';
import { prativedanLedgerReceiptSchema } from './prativedan-drafts';
import {
  PRATIVEDAN_RENDERER_CONFIG_VERSION,
  PRATIVEDAN_RENDERER_CONFIG_SHA256,
  PRATIVEDAN_RENDERER_CONFIG_TEXT,
} from './prativedan-renderer-config';

/** Unmounted SQL 0123 wire shapes only. Trusted loaders, independent ledger
 * witnesses, exact byte hashes and semantic rendering checks remain separate.
 * This codec grants neither invocation nor publication authority. */
const nil = '00000000-0000-0000-0000-000000000000';
// PostgreSQL UUID and 0123 accept canonical lowercase hex, without a version restriction.
const uuid = z
  .string()
  .regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/)
  .refine((value) => value !== nil);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const text = (maxBytes: number) =>
  z
    .string()
    .min(1)
    .max(maxBytes)
    .refine(
      (value) =>
        !value.includes('\0') &&
        !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value) &&
        new TextEncoder().encode(value).byteLength <= maxBytes,
    );
// Validate calendar/offset syntax before using this bounded exact instant
// representation. Date.parse supplies whole seconds only; fractional digits
// are retained independently so PostgreSQL microseconds never collapse.
function timestampNanoseconds(value: string): bigint | null {
  const parts = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/.exec(
    value,
  );
  if (!parts) return null;
  const whole = Date.parse(`${parts[1]}${parts[3]}`);
  if (!Number.isFinite(whole)) return null;
  return BigInt(whole) * 1_000_000n + BigInt((parts[2] ?? '').padEnd(9, '0'));
}
const timestamp = z.iso
  .datetime({ offset: true })
  .refine((value) => timestampNanoseconds(value) !== null);
const ordered = (...ids: string[]) =>
  ids.every((id) => /^[1-9][0-9]{0,18}$/.test(id)) &&
  ids.every((id, index) => index === 0 || BigInt(ids[index - 1]!) < BigInt(id));
const receipt = prativedanLedgerReceiptSchema;
const sourceReceipts = z
  .object({ started: receipt, completed: receipt, finalized: receipt })
  .strict()
  .refine((v) => ordered(v.started.id, v.completed.id, v.finalized.id));

export const prativedanAssessmentSourceSchema = z
  .object({
    schema_version: z.literal(2),
    serialization: z.literal('postgres-jsonb-text-v1'),
    kind: z.literal('prativedan_assessment_source'),
    source_id: uuid,
    tenant_id: uuid,
    engagement_id: uuid,
    assessment_run_id: uuid,
    title: text(1200).refine((value) => [...value].length <= 300),
    library_version: text(800).refine((value) => [...value].length <= 200),
    controls_text: text(524288),
    controls_sha256: digest,
    result_text: text(524288),
    result_sha256: digest,
    completed_at: timestamp,
    finalized_at: timestamp,
    receipts: sourceReceipts,
    limitations: z.tuple([
      z.literal('Recorded questionnaire computation; no independent evidence verification.'),
      z.literal('Current remediation state is not included.'),
      z.literal('Not a compliance certification or legal opinion.'),
    ]),
  })
  .strict()
  .refine((v) => {
    const completed = timestampNanoseconds(v.completed_at);
    const finalized = timestampNanoseconds(v.finalized_at);
    return (
      v.source_id === v.assessment_run_id &&
      completed !== null &&
      finalized !== null &&
      completed <= finalized
    );
  });

export const prativedanAssessmentDraftRequestSchema = z
  .object({
    operationKey: uuid,
    engagementId: uuid,
    assessmentRunId: uuid,
    expectedSourceSha256: digest,
    sourceReviewed: z.literal(true),
  })
  .strict();
const controlId = text(400).refine((value) => [...value].length <= 100 && value === value.trim());
const projectionTitle = text(1200).refine((value) => [...value].length <= 300);
export const prativedanAssessmentRendererInputSchema = z
  .object({
    tenant_id: uuid,
    engagement_id: uuid,
    title: projectionTitle,
    kind: z.literal('board'),
    findings: z
      .array(
        z
          .object({
            control_id: controlId,
            title: projectionTitle,
            severity: z.enum(['info', 'low', 'medium', 'high', 'critical']),
            score: z.number().finite().min(0).max(100),
            rationale: text(20000),
          })
          .strict(),
      )
      .min(1)
      .max(500),
    posture_score: z.number().finite().min(0).max(100),
    estimated_exposure_inr: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    library_version: text(800).refine((value) => [...value].length <= 200),
    library_control_ids: z.array(controlId).min(1).max(500),
    reviewer_id: z.null(),
  })
  .strict()
  .refine((v) => {
    const controls = new Set(v.library_control_ids);
    const findings = new Set(v.findings.map((f) => f.control_id));
    return (
      controls.size === v.library_control_ids.length &&
      findings.size === v.findings.length &&
      findings.size === controls.size &&
      [...findings].every((id) => controls.has(id))
    );
  });

export const prativedanAssessmentPreviewSchema = z
  .object({
    source_text: text(1048576),
    source_sha256: digest,
    publication_allowed: z.literal(false),
  })
  .strict();
const receiptId = receipt.shape.id;
export const prativedanAssessmentRequestAcknowledgementSchema = z
  .object({
    run_id: uuid,
    operation_key: uuid,
    requested_receipt: receiptId,
    replayed: z.boolean(),
  })
  .strict();
export const prativedanAssessmentMissingSchema = z.object({ missing: z.literal(true) }).strict();
const base = {
  schema_version: z.literal(2),
  kind: z.literal('prativedan_unpublished_draft'),
  tenant_id: uuid,
  operation_key: uuid,
  actor_id: uuid,
  source_id: uuid,
  assessment_run_id: uuid,
  engagement_id: uuid,
  run_id: uuid,
  source_text: text(1048576),
  source_sha256: digest,
  request_text: text(4096),
  request_sha256: digest,
  renderer_config_version: z.literal(PRATIVEDAN_RENDERER_CONFIG_VERSION),
  renderer_config_sha256: z.literal(PRATIVEDAN_RENDERER_CONFIG_SHA256),
  renderer_config_text: z.literal(PRATIVEDAN_RENDERER_CONFIG_TEXT),
  requested_receipt: receipt,
  publication_allowed: z.literal(false),
  review_required: z.literal(true),
  citation_verification: z.literal('unverified_references'),
};
const claim = {
  claimed_receipt: receipt,
  normalized_input_text: text(1048576),
  runtime_normalized_input_sha256: digest,
  claim_expires_at: timestamp,
};
const title = text(1200).refine((value) => [...value].length <= 300);
const body = (type: string, heading: string) =>
  z.object({ type: z.literal(type), title: z.literal(heading), body: text(32000) }).strict();
export const prativedanAssessmentDraftOutputSchema = z
  .object({
    title,
    kind: z.literal('board'),
    generated_by_agent: z.literal('prativedan'),
    cited_evidence_ids: z.array(z.never()).max(0),
    rendered_html: text(2097152),
    review_required: z.literal(true),
    citation_verification: z.literal('unverified_references'),
    sections: z.tuple([
      body('executive_summary', 'Executive summary'),
      z
        .object({
          type: z.literal('findings_table'),
          title: z.literal('Findings for review (source order)'),
          items: z
            .array(
              z
                .object({
                  control_id: text(100),
                  title,
                  severity: z.enum(['info', 'low', 'medium', 'high', 'critical']),
                  score: z.number().finite().min(0).max(100),
                  rationale: text(20000),
                  risk_points: z.null(),
                })
                .strict(),
            )
            .min(1)
            .max(10),
        })
        .strict(),
      body('library', 'Control library'),
      body('attribution', 'Draft attribution and review status'),
    ]),
  })
  .strict();
const review = z
  .object({
    actor_id: uuid,
    review_key: uuid,
    decision: z.enum(['accepted', 'rejected']),
    reason: text(8000).refine(
      (value) =>
        [...value].length >= 20 &&
        [...value].length <= 2000 &&
        !value.startsWith(' ') &&
        !value.endsWith(' '),
    ),
    response_output_sha256: digest,
    receipt,
  })
  .strict();
const identities = (v: { source_id: string; assessment_run_id: string; run_id: string }) =>
  v.source_id === v.assessment_run_id && v.run_id !== v.source_id;
export const prativedanAssessmentRequestedSchema = z
  .object({ ...base, state: z.literal('requested') })
  .strict()
  .refine(identities);
export const prativedanAssessmentUncertainSchema = z
  .object({ ...base, ...claim, state: z.literal('invocation_uncertain') })
  .strict()
  .refine((v) => identities(v) && ordered(v.requested_receipt.id, v.claimed_receipt.id));
export const prativedanAssessmentUnpublishedSchema = z
  .object({
    ...base,
    ...claim,
    state: z.literal('unpublished'),
    draft_id: uuid,
    runtime_output_text: text(2097152),
    runtime_output_sha256: digest,
    response_output_text: text(2097152),
    response_output_sha256: digest,
    output: prativedanAssessmentDraftOutputSchema,
    started_receipt: receipt,
    completed_receipt: receipt,
    settled_receipt: receipt,
    review: review.optional(),
  })
  .strict()
  .refine(
    (v) =>
      identities(v) &&
      ordered(
        v.requested_receipt.id,
        v.claimed_receipt.id,
        v.started_receipt.id,
        v.completed_receipt.id,
        v.settled_receipt.id,
      ) &&
      (!v.review ||
        (ordered(v.settled_receipt.id, v.review.receipt.id) &&
          v.review.response_output_sha256 === v.response_output_sha256)),
  );
export const prativedanAssessmentJournalSchema = z.union([
  prativedanAssessmentRequestedSchema,
  prativedanAssessmentUncertainSchema,
  prativedanAssessmentUnpublishedSchema,
]);
export const prativedanAssessmentReadbackSchema = z.union([
  prativedanAssessmentMissingSchema,
  prativedanAssessmentJournalSchema,
]);
export const prativedanAssessmentClaimSchema = z.union([
  z
    .object({
      claimed: z.literal(true),
      expires_at: timestamp,
      readback: prativedanAssessmentUncertainSchema,
    })
    .strict()
    .refine((v) => v.expires_at === v.readback.claim_expires_at),
  z
    .object({
      claimed: z.literal(false),
      invocation_uncertain: z.literal(true),
      readback: z.union([
        prativedanAssessmentUncertainSchema,
        prativedanAssessmentUnpublishedSchema,
      ]),
    })
    .strict(),
]);
/** Settlement adds replay acknowledgement to the otherwise exact journal. */
export const prativedanAssessmentSettlementSchema =
  prativedanAssessmentUnpublishedSchema.safeExtend({ replayed: z.boolean() });
export const prativedanAssessmentReviewAcknowledgementSchema = z
  .object({
    reviewed_receipt: receiptId,
    publication_allowed: z.literal(false),
    replayed: z.boolean(),
  })
  .strict();
export type PrativedanAssessmentSource = z.infer<typeof prativedanAssessmentSourceSchema>;
export type PrativedanAssessmentReadback = z.infer<typeof prativedanAssessmentReadbackSchema>;
export type PrativedanAssessmentClaim = z.infer<typeof prativedanAssessmentClaimSchema>;

export type PrativedanAssessmentPreview = z.infer<typeof prativedanAssessmentPreviewSchema>;
export type PrativedanAssessmentRequestAcknowledgement = z.infer<
  typeof prativedanAssessmentRequestAcknowledgementSchema
>;
export type PrativedanAssessmentJournal = z.infer<typeof prativedanAssessmentJournalSchema>;
export type PrativedanAssessmentRequested = z.infer<typeof prativedanAssessmentRequestedSchema>;
export type PrativedanAssessmentUncertain = z.infer<typeof prativedanAssessmentUncertainSchema>;
export type PrativedanAssessmentUnpublished = z.infer<typeof prativedanAssessmentUnpublishedSchema>;
export type PrativedanAssessmentDraftOutput = z.infer<typeof prativedanAssessmentDraftOutputSchema>;
export type PrativedanAssessmentSettlement = z.infer<typeof prativedanAssessmentSettlementSchema>;
export type PrativedanAssessmentReviewAcknowledgement = z.infer<
  typeof prativedanAssessmentReviewAcknowledgementSchema
>;

export type PrativedanAssessmentDraftRequest = z.infer<
  typeof prativedanAssessmentDraftRequestSchema
>;
export type PrativedanAssessmentRendererInput = z.infer<
  typeof prativedanAssessmentRendererInputSchema
>;
