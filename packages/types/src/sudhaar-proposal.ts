/** Source facts for read-only planning. Never an execution grant or a saved plan. */
import { z } from 'zod';
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const uuid = z.uuid().transform((v) => v.toLowerCase());
export const sudhaarProposalRequestSchema = z
  .object({
    operationKey: uuid,
    engagementId: uuid,
    assessmentRunId: uuid,
    title: z.string().trim().min(1).max(300).default('Assessment review proposal'),
  })
  .strict();
export const sudhaarSourceSchema = z
  .object({
    assessmentRunId: uuid,
    libraryVersion: z.string().min(1).max(200),
    libraryDigest: digest,
    resultDigest: digest,
    finalizedReceipt: z
      .string()
      .regex(/^[1-9][0-9]{0,18}$/)
      .refine((v) => BigInt(v) <= 9223372036854775807n),
  })
  .strict();
const counts = z
  .object({
    known: z.number().int().min(0).max(1000),
    affirmed: z.number().int().min(0).max(1000),
    denied: z.number().int().min(0).max(1000),
    unknown: z.number().int().min(0).max(1000),
  })
  .strict();
export const sudhaarFindingSchema = z
  .object({
    finding_id: uuid,
    control_id: z.string().min(1).max(100),
    title: z.string().min(1).max(300),
    severity: z.enum(['critical', 'high', 'medium', 'low', 'info']),
    score_decimal: z.string().regex(/^(?:100(?:\.0+)?|(?:[0-9]|[1-9][0-9])(?:\.[0-9]{1,6})?)$/),
    risk_points_decimal: z.string().regex(/^(?:0|[1-9][0-9]{0,4})(?:\.[0-9]{1,6})?$/),
    answer_state: z.enum([
      'unknown',
      'partially_answered',
      'caller_declared_unverified',
      'not_boolean_assessable',
      'unavailable',
    ]),
    applicability_state: z.enum([
      'unconditional',
      'unknown',
      'caller_declared_applicable_unverified',
      'caller_declared_not_applicable_unverified',
      'unavailable',
    ]),
    answer_counts: counts.nullable(),
  })
  .strict()
  .superRefine((v, c) => {
    const n = v.answer_counts;
    const expected = n
      ? n.known === 0
        ? 'not_boolean_assessable'
        : n.unknown === n.known
          ? 'unknown'
          : n.unknown
            ? 'partially_answered'
            : 'caller_declared_unverified'
      : 'unavailable';
    if (
      v.answer_state !== expected ||
      (n && n.known !== n.affirmed + n.denied + n.unknown) ||
      (n === null) !== (v.applicability_state === 'unavailable')
    )
      c.addIssue({ code: 'custom', message: 'Unbound planning declarations' });
  });
export const sudhaarInputSchema = z
  .object({
    tenant_id: uuid,
    engagement_id: uuid,
    title: z.string().min(1).max(300),
    source: sudhaarSourceSchema,
    findings: z.array(sudhaarFindingSchema).min(1).max(500),
  })
  .strict()
  .refine(
    (v) =>
      new Set(v.findings.map((f) => f.finding_id)).size === v.findings.length &&
      new Set(v.findings.map((f) => f.control_id)).size === v.findings.length,
    'Duplicate planning sources',
  )
  .refine(
    (v) =>
      v.findings.reduce((n, f) => n + (f.answer_counts?.known ?? 0), 0) <= 5000 &&
      new TextEncoder().encode(JSON.stringify(v)).byteLength <= 524288,
    'Planning source size refused',
  );
// Server-to-runtime facts remain bounded independently of browser request size.
export type SudhaarInput = z.infer<typeof sudhaarInputSchema>;
export function sudhaarReviewReason(f: SudhaarInput['findings'][number]) {
  if (f.answer_state === 'unavailable') return 'provenance_unavailable' as const;
  if (f.applicability_state !== 'unconditional') return 'applicability_unverified' as const;
  if (f.answer_state === 'unknown' || f.answer_state === 'partially_answered')
    return 'questionnaire_incomplete' as const;
  if (f.answer_state === 'not_boolean_assessable') return 'evidence_required' as const;
  return 'declarations_unverified' as const;
}
export const sudhaarReviewTaskSchema = z
  .object({
    sequence: z.number().int().min(1).max(500),
    finding_id: uuid,
    control_id: z.string().min(1).max(100),
    title: z.string().min(1).max(300),
    reason: z.enum([
      'provenance_unavailable',
      'applicability_unverified',
      'questionnaire_incomplete',
      'evidence_required',
      'declarations_unverified',
    ]),
    instruction: z.literal(
      'Review the recorded questionnaire, applicability and supporting evidence before proposing corrective work. No finding is closed by this proposal.',
    ),
  })
  .strict();
export const sudhaarProposalSchema = z
  .object({
    schema_version: z.literal(1),
    kind: z.literal('remediation_proposal'),
    title: z.string().min(1).max(300),
    source: sudhaarSourceSchema,
    persistence: z.literal('not_saved'),
    review_required: z.literal(true),
    escalate: z.literal(true),
    execution_allowed: z.literal(false),
    review_tasks: z.array(sudhaarReviewTaskSchema).min(1).max(500),
    provisional_actions: z.array(z.never()).max(0),
    aggregate_records_affected: z.null(),
    aggregate_systems: z.array(z.never()).max(0),
  })
  .strict();
export function validateSudhaarProposal(value: unknown, inputValue: unknown) {
  const input = sudhaarInputSchema.parse(inputValue),
    proposal = sudhaarProposalSchema.parse(value);
  if (
    JSON.stringify(proposal.source) !== JSON.stringify(input.source) ||
    proposal.title !== input.title ||
    proposal.review_tasks.length !== input.findings.length
  )
    throw new Error('Planning source binding refused');
  const tasks = new Map(proposal.review_tasks.map((t) => [t.finding_id, t]));
  if (
    tasks.size !== input.findings.length ||
    proposal.review_tasks.some((t) => t.sequence > input.findings.length) ||
    new Set(proposal.review_tasks.map((t) => t.sequence)).size !== input.findings.length
  )
    throw new Error('Planning register refused');
  for (const f of input.findings) {
    const t = tasks.get(f.finding_id);
    if (
      !t ||
      t.control_id !== f.control_id ||
      t.title !== f.title ||
      t.reason !== sudhaarReviewReason(f)
    )
      throw new Error('Planning finding binding refused');
  }
  return proposal;
}
