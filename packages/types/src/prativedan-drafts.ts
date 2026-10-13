import { z } from 'zod';
import { PRATIVEDAN_RENDERER_CONFIG_VERSION } from './prativedan-renderer-config';

/** Shape checks only: trusted loaders, actual runtime receipts and byte hashes
 * establish authority. None of these declarations grants source access,
 * proves human review, or authorizes publication. Numeric codecs remain separate.
 */
export const PRATIVEDAN_SOURCE_MAX_BYTES = 4 * 1024 * 1024;
export const PRATIVEDAN_INPUT_MAX_BYTES = 1024 * 1024;
export const PRATIVEDAN_OUTPUT_MAX_BYTES = 2 * 1024 * 1024;
const uuid = z.uuidv4().refine((value) => value === value.toLowerCase());
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const text = (maxBytes: number, min = 1) =>
  z
    .string()
    .min(min)
    .max(maxBytes)
    .refine(
      (value) =>
        !value.includes('\0') &&
        !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value) &&
        new TextEncoder().encode(value).byteLength <= maxBytes,
      { message: 'Invalid or oversized UTF-8 text' },
    );
const identifier = text(100).refine((value) => value === value.trim());
const receiptId = z
  .string()
  .regex(/^[1-9][0-9]{0,18}$/)
  .refine(
    (value) => /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= 9_223_372_036_854_775_807n,
  );
const receiptsOrdered = (...ids: string[]) =>
  ids.every((id) => /^[1-9][0-9]{0,18}$/.test(id)) &&
  ids.every((id, index) => index === 0 || BigInt(ids[index - 1]!) < BigInt(id));
export const prativedanLedgerReceiptSchema = z
  .object({ id: receiptId, entry_hash: digest })
  .strict();
const sourceReceipts = z
  .object({
    started: prativedanLedgerReceiptSchema,
    completed: prativedanLedgerReceiptSchema,
    finalized: prativedanLedgerReceiptSchema,
  })
  .strict()
  .refine(
    (receipts) =>
      receiptsOrdered(receipts.started.id, receipts.completed.id, receipts.finalized.id),
    { message: 'Assessment receipts must be ordered and distinct' },
  );

/** Only references and an explicit acknowledgement; never caller findings. */
export const prativedanDraftRequestSchema = z
  .object({
    operationKey: uuid,
    engagementId: uuid,
    assessmentRunId: uuid,
    expectedSourceSha256: digest,
    sourceReviewed: z.literal(true),
  })
  .strict();

/** Existing immutable PostgreSQL board_source bytes retain their actual kind. */
export const prativedanFrozenSourceSchema = z
  .object({
    schema_version: z.literal(1),
    serialization: z.literal('postgres-jsonb-text-v1'),
    kind: z.literal('board_source'),
    request_id: uuid,
    tenant_id: uuid,
    engagement_id: uuid,
    assessment_run_id: uuid,
    library_version: identifier,
    controls_text: text(PRATIVEDAN_SOURCE_MAX_BYTES),
    controls_sha256: digest,
    result_text: text(PRATIVEDAN_SOURCE_MAX_BYTES),
    result_sha256: digest,
    completed_at: z.iso.datetime({ offset: true }),
    finalized_at: z.iso.datetime({ offset: true }),
    receipts: sourceReceipts,
    limitations: z.array(text(2000)).min(1).max(20),
  })
  .strict()
  .refine((source) => Date.parse(source.completed_at) <= Date.parse(source.finalized_at), {
    message: 'Assessment finalization predates completion',
  });

export const prativedanSourceWitnessSchema = z
  .object({
    source_id: uuid,
    tenant_id: uuid,
    engagement_id: uuid,
    assessment_run_id: uuid,
    library_version: identifier,
    title: text(300).refine((value) => value === value.trim()),
    source_text: text(PRATIVEDAN_SOURCE_MAX_BYTES),
    source_sha256: digest,
    controls_sha256: digest,
    result_sha256: digest,
    receipts: sourceReceipts,
  })
  .strict();

const score = z.number().finite().min(0).max(100).nullable();
const finding = z
  .object({
    control_id: identifier,
    title: text(1000),
    severity: z.enum(['info', 'low', 'medium', 'high', 'critical']),
    score,
    rationale: text(20000),
  })
  .strict();
/** Fully explicit trusted renderer input; no default expansion in TypeScript. */
export const prativedanRendererInputSchema = z
  .object({
    tenant_id: uuid,
    engagement_id: uuid,
    kind: z.literal('board'),
    title: text(300),
    findings: z.array(finding).min(1).max(500),
    posture_score: score,
    estimated_exposure_inr: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
    library_version: identifier,
    library_control_ids: z.array(identifier).min(1).max(500),
    reviewer_id: z.null(),
  })
  .strict()
  .superRefine((input, context) => {
    const controls = input.library_control_ids;
    const findings = input.findings.map((row) => row.control_id);
    if (
      new Set(controls).size !== controls.length ||
      new Set(findings).size !== findings.length ||
      findings.length !== controls.length ||
      findings.some((id) => !controls.includes(id)) ||
      new TextEncoder().encode(JSON.stringify(input)).byteLength > PRATIVEDAN_INPUT_MAX_BYTES
    )
      context.addIssue({ code: 'custom', message: 'Renderer source cardinality or size refused' });
  });

const bodySection = (kind: 'executive_summary' | 'library' | 'attribution') =>
  z
    .object({
      type: z.literal(kind),
      title: text(300),
      body: text(32000),
    })
    .strict();
const findingItem = finding.extend({ risk_points: z.null() }).strict();
export const prativedanDraftOutputSchema = z
  .object({
    title: text(300),
    kind: z.literal('board'),
    sections: z.tuple([
      bodySection('executive_summary'),
      z
        .object({
          type: z.literal('findings_table'),
          title: text(300),
          items: z.array(findingItem).max(10),
        })
        .strict(),
      bodySection('library'),
      bodySection('attribution'),
    ]),
    cited_evidence_ids: z.array(uuid).max(0),
    generated_by_agent: z.literal('prativedan'),
    rendered_html: text(PRATIVEDAN_OUTPUT_MAX_BYTES),
    review_required: z.literal(true),
    citation_verification: z.literal('unverified_references'),
  })
  .strict()
  .refine(
    (output) =>
      new TextEncoder().encode(JSON.stringify(output)).byteLength <= PRATIVEDAN_OUTPUT_MAX_BYTES,
    { message: 'Draft output size limit exceeded' },
  );

const binding = {
  tenant_id: uuid,
  engagement_id: uuid,
  source_id: uuid,
  assessment_run_id: uuid,
  run_id: uuid,
  operation_key: uuid,
};
const rendererCommitment = {
  renderer_config_version: z.literal(PRATIVEDAN_RENDERER_CONFIG_VERSION),
  renderer_config_sha256: digest,
};
/** Trusted retained dispatch/claim contracts, never browser request bodies.
 * Runtime independently validates this config commitment against its real manifest.
 */
export const prativedanRecordedDispatchSchema = z
  .object({
    ...binding,
    ...rendererCommitment,
    request_text: text(4096),
    request_sha256: digest,
    source_sha256: digest,
    requested_receipt: prativedanLedgerReceiptSchema,
  })
  .strict();
export const prativedanDispatchClaimSchema = z
  .object({
    ...binding,
    ...rendererCommitment,
    request_sha256: digest,
    source_sha256: digest,
    runtime_normalized_input_sha256: digest,
    claimed: z.literal(true),
    expires_at_ms: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
const hashDomains = {
  source_sha256: digest,
  request_sha256: digest,
  runtime_normalized_input_sha256: digest,
  runtime_output_sha256: digest,
};
const invocation = {
  ...rendererCommitment,
  agent: z.literal('prativedan'),
  agent_version: text(100),
  correlation_id: uuid,
  target_ref: text(500),
  requested_receipt: prativedanLedgerReceiptSchema,
  started_receipt: prativedanLedgerReceiptSchema,
  completed_receipt: prativedanLedgerReceiptSchema,
};
const orderedInvocation = (value: {
  requested_receipt: { id: string };
  started_receipt: { id: string };
  completed_receipt: { id: string };
}) =>
  receiptsOrdered(value.requested_receipt.id, value.started_receipt.id, value.completed_receipt.id);

/** Authenticated transport declarations still require independently loaded receipts. */
export const prativedanRuntimeEnvelopeSchema = z
  .object({
    ...binding,
    ...hashDomains,
    ...invocation,
    renderer_config_text: text(16384),
    normalized_input_text: text(PRATIVEDAN_INPUT_MAX_BYTES),
    runtime_output_text: text(PRATIVEDAN_OUTPUT_MAX_BYTES),
    output: prativedanDraftOutputSchema,
    review_required: z.literal(true),
    citation_verification: z.literal('unverified_references'),
  })
  .strict()
  .refine(orderedInvocation, { message: 'Invocation receipts must be ordered' });

/** Must come from actual retained ledger rows, independently of the runtime envelope. */
export const prativedanReceiptWitnessSchema = z
  .object({
    ...binding,
    ...hashDomains,
    ...invocation,
  })
  .strict()
  .refine(orderedInvocation, { message: 'Invocation receipts must be ordered' });

/** Five byte domains plus a distinct renderer identity commitment. Equal byte
 * hashes are never a codec requirement; hash-only recovered identity is refused.
 */
export const prativedanDraftReadbackProofSchema = z
  .object({
    kind: z.literal('prativedan_unpublished_draft'),
    schema_version: z.literal(1),
    ...binding,
    ...hashDomains,
    ...invocation,
    draft_id: uuid,
    actor_id: uuid,
    request: prativedanDraftRequestSchema,
    request_text: text(2048),
    renderer_config_text: text(16384),
    normalized_input_text: text(PRATIVEDAN_INPUT_MAX_BYTES),
    runtime_output_text: text(PRATIVEDAN_OUTPUT_MAX_BYTES),
    response_output_sha256: digest,
    settled_receipt: prativedanLedgerReceiptSchema,
    state: z.literal('unpublished'),
    publication_allowed: z.literal(false),
    review_required: z.literal(true),
    citation_verification: z.literal('unverified_references'),
    output: prativedanDraftOutputSchema,
  })
  .strict()
  .refine(
    (proof) =>
      orderedInvocation(proof) &&
      receiptsOrdered(proof.completed_receipt.id, proof.settled_receipt.id) &&
      proof.operation_key === proof.request.operationKey &&
      proof.engagement_id === proof.request.engagementId &&
      proof.assessment_run_id === proof.request.assessmentRunId &&
      proof.source_sha256 === proof.request.expectedSourceSha256,
    { message: 'Readback original request or settlement binding refused' },
  );

export type PrativedanDraftRequest = z.infer<typeof prativedanDraftRequestSchema>;
export type PrativedanFrozenSource = z.infer<typeof prativedanFrozenSourceSchema>;
export type PrativedanSourceWitness = z.infer<typeof prativedanSourceWitnessSchema>;
export type PrativedanRendererInput = z.infer<typeof prativedanRendererInputSchema>;
export type PrativedanDraftOutput = z.infer<typeof prativedanDraftOutputSchema>;
export type PrativedanRuntimeEnvelope = z.infer<typeof prativedanRuntimeEnvelopeSchema>;
export type PrativedanReceiptWitness = z.infer<typeof prativedanReceiptWitnessSchema>;
export type PrativedanDraftReadbackProof = z.infer<typeof prativedanDraftReadbackProofSchema>;
export type PrativedanRecordedDispatch = z.infer<typeof prativedanRecordedDispatchSchema>;
export type PrativedanDispatchClaim = z.infer<typeof prativedanDispatchClaimSchema>;
