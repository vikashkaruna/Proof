import { z } from 'zod';
import {
  deliveryTaskPayloadSchema,
  policyDocumentPayloadSchema,
  processingActivityPayloadSchema,
  workflowRecordSchema,
} from './operator-workflows';

const uuid = z.uuid().transform((value) => value.toLowerCase());
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const receipt = z
  .string()
  .regex(/^[1-9][0-9]{0,18}$/)
  .refine(
    (value) => /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= 9_223_372_036_854_775_807n,
  );
const sourceRecord = z.discriminatedUnion('kind', [
  workflowRecordSchema.options[0].extend({ content_sha256: z.null(), receipt_id: receipt }),
  workflowRecordSchema.options[1].extend({ content_sha256: z.null(), receipt_id: receipt }),
]);

/** Shape and consistency only. The protected server workflow must load actual
 * immutable records, validate their human receipts and current authority, and
 * compute source_records_sha256 from their canonical ordered bytes.
 */
export const reviewedWorkflowInputSchema = z
  .object({
    schema_version: z.literal(1),
    mode: z.literal('reviewed_workflow'),
    tenant_id: uuid,
    engagement_id: uuid,
    source_records_sha256: digest,
    records: z.array(sourceRecord).min(1).max(20),
  })
  .strict()
  .superRefine((input, context) => {
    const records = input.records;
    if (
      records.some(
        (record) =>
          record.tenant_id !== input.tenant_id ||
          record.payload.engagementId !== input.engagement_id,
      ) ||
      new Set(records.map((record) => record.id)).size !== records.length ||
      new Set(records.map((record) => record.operation_key)).size !== records.length ||
      new Set(records.map((record) => record.receipt_id)).size !== records.length ||
      new TextEncoder().encode(JSON.stringify(input)).byteLength > 524_288
    )
      context.addIssue({ code: 'custom', message: 'Reviewed source register refused' });
  });
export type ReviewedWorkflowInput = z.infer<typeof reviewedWorkflowInputSchema>;
const reference = z
  .object({
    record_id: uuid,
    human_receipt_id: receipt,
    created_by: uuid,
    record_kind: z.enum(['ropa', 'delivery_task']),
  })
  .strict();
const policyCategory = z.enum(['privacy_notice', 'consent_notice', 'retention', 'dpa_template']);
export const reviewedWorkflowOutputSchema = z
  .object({
    schema_version: z.literal(1),
    mode: z.literal('reviewed_workflow'),
    source_records_sha256: digest,
    processing_reviews: z
      .array(
        z
          .object({
            source: reference,
            declarations: processingActivityPayloadSchema,
            unresolved_fields: z.array(z.string()).max(20),
            declaration_status: z.literal('human_recorded_unverified'),
            review_required: z.literal(true),
          })
          .strict(),
      )
      .max(20),
    policy_drafts: z
      .array(
        z
          .object({
            source: reference,
            source_ropa_id: uuid,
            category: policyCategory,
            title: policyDocumentPayloadSchema.shape.title,
            content: policyDocumentPayloadSchema.shape.content,
            review_required: z.literal(true),
            legal_review_required: z.literal(true),
            publication_status: z.literal('unpublished'),
          })
          .strict(),
      )
      .max(80),
    playbook_reviews: z
      .array(
        z
          .object({
            source: reference,
            reported_task: deliveryTaskPayloadSchema,
            reported_total_minutes: z.number().int().min(0).max(1_000_000_000_000),
            measurement_status: z.literal('not_verified'),
            ranking_basis: z.literal('human_reported_time_only'),
            time_horizon: z.literal('not_recorded'),
            automation_candidate: z.literal(false),
            review_required: z.literal(true),
          })
          .strict(),
      )
      .max(20),
    persistence: z.literal('not_saved'),
    review_required: z.literal(true),
    execution_allowed: z.literal(false),
    publication_allowed: z.literal(false),
  })
  .strict()
  .refine(
    (output) => new TextEncoder().encode(JSON.stringify(output)).byteLength <= 524_288,
    'Reviewed draft output refused',
  );
export type ReviewedWorkflowOutput = z.infer<typeof reviewedWorkflowOutputSchema>;

/** Validated output is still an unpublished proposal. This does not establish
 * genuine runtime receipts, durable persistence or permission to adopt/publish.
 */
export function validateReviewedWorkflowOutput(
  rawInput: unknown,
  rawOutput: unknown,
): ReviewedWorkflowOutput {
  const input = reviewedWorkflowInputSchema.parse(rawInput);
  const output = reviewedWorkflowOutputSchema.parse(rawOutput);
  const processing = input.records.filter((record) => record.kind === 'ropa');
  const delivery = input.records
    .filter((record) => record.kind === 'delivery_task')
    .sort(
      (a, b) =>
        b.payload.durationMinutes * b.payload.repetitions -
        a.payload.durationMinutes * a.payload.repetitions,
    );
  const exact = (a: unknown, b: unknown): boolean => {
    if (a === b) return true;
    if (Array.isArray(a) || Array.isArray(b))
      return (
        Array.isArray(a) &&
        Array.isArray(b) &&
        a.length === b.length &&
        a.every((value, index) => exact(value, b[index]))
      );
    if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
    const left = a as Record<string, unknown>,
      right = b as Record<string, unknown>;
    const keys = Object.keys(left).sort();
    return (
      exact(keys, Object.keys(right).sort()) && keys.every((key) => exact(left[key], right[key]))
    );
  };
  // Retained bytes must not be silently normalised into different facts/IDs.
  if (!exact(rawInput, input) || !exact(rawOutput, output))
    throw new Error('reviewed_output_source_refused');
  const source = (record: ReviewedWorkflowInput['records'][number]) => ({
    record_id: record.id,
    human_receipt_id: record.receipt_id,
    created_by: record.created_by,
    record_kind: record.kind,
  });
  if (
    output.source_records_sha256 !== input.source_records_sha256 ||
    output.processing_reviews.length !== processing.length ||
    output.playbook_reviews.length !== delivery.length ||
    output.policy_drafts.length !== processing.length * 4
  )
    throw new Error('reviewed_output_source_refused');
  if (!exact(output.policy_drafts, processing.flatMap(expectedPolicies)))
    throw new Error('reviewed_output_source_refused');
  processing.forEach((record, index) => {
    const review = output.processing_reviews[index]!;
    const unresolved = Object.entries(record.payload)
      .filter(([field, value]) => value === null && !['engagementId', 'source'].includes(field))
      .map(([field]) => field)
      .sort();
    if (
      !exact(review.source, source(record)) ||
      !exact(review.declarations, record.payload) ||
      !exact([...review.unresolved_fields].sort(), unresolved)
    )
      throw new Error('reviewed_output_source_refused');
  });
  delivery.forEach((record, index) => {
    const review = output.playbook_reviews[index]!;
    if (
      !exact(review.source, source(record)) ||
      !exact(review.reported_task, record.payload) ||
      review.reported_total_minutes !== record.payload.durationMinutes * record.payload.repetitions
    )
      throw new Error('reviewed_output_source_refused');
  });
  return output;
}

const declarationLabels: Record<string, string> = {
  engagementId: 'engagement',
  sourceNote: 'source and reason',
  system: 'system',
  purpose: 'purpose',
  legalBasis: 'legal basis',
  retentionMonths: 'retention in months',
  dataCategories: 'data categories',
  dataPrincipals: 'data principal groups',
  processors: 'processors',
  recipients: 'recipients',
  destinationCountries: 'destination countries',
  transferSafeguards: 'transfer safeguards',
  dpiaRequired: 'impact assessment required',
  region: 'processing location',
  crossBorder: 'cross-border processing',
  securityMeasures: 'security measures',
};
const policyPrompts = {
  privacy_notice: [
    'Privacy Notice',
    'Confirm organisation identity, contacts, rights routes, notice languages and applicable obligations before publication.',
  ],
  consent_notice: [
    'Consent Notice',
    'Confirm specific purposes, lawful basis, clear affirmative action, notice language, consent records and withdrawal routes. No consent is proven by this draft.',
  ],
  retention: [
    'Retention Policy',
    'Confirm retention triggers, deletion methods, legal holds, exceptions, owners and review schedule. No deletion is authorised by this draft.',
  ],
  dpa_template: [
    'Data Processing Agreement Template',
    'Verify parties, roles, instructions, subprocessors, security, incidents, audit terms, transfers and signatures with legal counsel. This unsigned draft creates no agreement.',
  ],
} as const;
function declared(value: unknown): string {
  if (value === null) return 'Unknown — authorised human confirmation required';
  if (Array.isArray(value))
    return value.length ? value.join(', ') : 'Human recorded none (review required)';
  if (typeof value === 'boolean')
    return value ? 'Human recorded yes (review required)' : 'Human recorded no (review required)';
  return String(value);
}
function expectedPolicies(
  record: Extract<ReviewedWorkflowInput['records'][number], { kind: 'ropa' }>,
): ReviewedWorkflowOutput['policy_drafts'] {
  const payload = record.payload;
  const source = {
    record_id: record.id,
    human_receipt_id: record.receipt_id,
    created_by: record.created_by,
    record_kind: record.kind,
  };
  const content = [
    'Human and legal review required. Recorded declarations are not independently verified processing or legal facts.',
    `Human source record: ${record.id}`,
    `Human audit receipt: ${record.receipt_id}`,
    `Original recorded actor: ${record.created_by}`,
    ...Object.entries(payload)
      .filter(([field]) => field !== 'source')
      .map(([field, value]) => `Recorded ${declarationLabels[field]}: ${declared(value)}`),
    ...(payload.source
      ? [
          `Retained public observation: ${payload.source.observationId}`,
          `Public observation output SHA-256: ${payload.source.outputSha256}`,
        ]
      : []),
    'Public HTML provenance does not establish private processing facts, residency, contracts, lawful basis or compliance.',
    'Approval, publication and execution remain separate human decisions.',
  ];
  return (Object.keys(policyPrompts) as (keyof typeof policyPrompts)[]).map((category) => {
    const [label, prompt] = policyPrompts[category];
    return {
      source,
      source_ropa_id: record.id,
      category,
      title: `Draft ${label} — ${payload.system}`,
      content: [`DRAFT ${label.toUpperCase()} — UNPUBLISHED`, ...content, prompt].join('\n\n'),
      review_required: true,
      legal_review_required: true,
      publication_status: 'unpublished',
    };
  });
}
