/** A recorded remediation register. All displayed action facts come from frozen SQL. */
import { createHash } from 'node:crypto';
import { z } from 'zod';

const uuid = z.uuid();
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const date = z.string().refine((value) => Number.isFinite(Date.parse(value)));
const nullableDate = date.nullable();
const nullableDigest = digest.nullable();
const planSchema = z.strictObject({
  id: uuid,
  engagement_id: uuid,
  library_version: z.string().min(1).max(200),
  title: z.string().min(1).max(1000),
  status: z.string().min(1).max(60),
  version: z.number().int().positive(),
  created_at: date,
  updated_at: date,
});
const actionSchema = z.strictObject({
  id: uuid,
  sequence: z.number().int().positive(),
  action_type: z.string().min(1).max(100),
  description: z.string().min(1).max(8192),
  risk_class: z.enum(['low', 'medium', 'high', 'critical']),
  risk_score: z.number().finite().min(0).max(100),
  parameters_sha256: digest,
  rollback_definition_sha256: digest,
  rollback_validation_recorded: z.boolean(),
  rollback_validated_at: nullableDate,
  approval_status_recorded: z.string().min(1).max(60),
  approval: z
    .strictObject({
      id: uuid,
      status: z.string().min(1).max(60),
      approver_id: uuid,
      issued_at: date,
      expires_at: date,
      consumed_at: nullableDate,
    })
    .nullable(),
  dry_run: z
    .strictObject({
      id: uuid,
      status: z.enum(['succeeded', 'refused', 'failed']),
      renderable: z.boolean(),
      created_at: date,
      expires_at: date,
      diff_sha256: nullableDigest,
    })
    .nullable(),
  execution: z
    .strictObject({
      batch_id: uuid,
      batch_status: z.string().min(1).max(60),
      content_digest: digest,
      started_at: date,
      finished_at: nullableDate,
      action_status: z.string().min(1).max(60),
      final_outcome: z.string().min(1).max(60).nullable(),
      executed_at: nullableDate,
      executed_by_agent: z.string().min(1).max(100).nullable(),
      pre_state_ref_recorded: z.boolean(),
      post_state_ref_recorded: z.boolean(),
    })
    .nullable(),
  rollback_execution: z
    .strictObject({
      id: uuid,
      status: z.enum(['succeeded', 'failed', 'partial']),
      definition_hash: digest,
      triggered_by: z.enum(['failure_threshold', 'manual', 'governor', 'verification']),
      finished_at: nullableDate,
    })
    .nullable(),
  verification: z
    .strictObject({
      id: uuid,
      outcome: z.enum(['passed', 'failed']),
      verified_at: date,
      evidence_ref_recorded: z.boolean(),
    })
    .nullable(),
  reconciliation: z
    .strictObject({
      id: uuid,
      created_at: date,
      unexecuted_count: z.number().int().nonnegative(),
      parameter_diff_count: z.number().int().nonnegative(),
    })
    .nullable(),
});
export const TechnicalSourceSchema = z.strictObject({
  schema_version: z.literal(1),
  serialization: z.literal('postgres-jsonb-text-v1'),
  kind: z.literal('technical_plan_source'),
  request_id: uuid,
  tenant_id: uuid,
  captured_at: date,
  plan: planSchema,
  actions: z.array(actionSchema).min(1).max(100),
  limitations: z.tuple([
    z.literal(
      'This is a frozen register of recorded plan and action state, not independent execution verification.',
    ),
    z.literal(
      'A recorded rollback validation flag is not a rollback execution; only linked rollback executions are shown.',
    ),
    z.literal(
      'References to pre/post state or verification evidence are not Object Lock or closure attestations.',
    ),
  ]),
});
export const TechnicalContentSchema = z.strictObject({
  schema_version: z.literal(2),
  kind: z.literal('technical_recorded_register'),
  source_kind: z.literal('recorded_remediation_plan'),
  request_id: uuid,
  tenant_id: uuid,
  plan_id: uuid,
  source_sha256: digest,
  title: z.string().min(1).max(300),
  generated_by: z.literal('technical-report-builder'),
});
const reviewSchema = z.strictObject({
  schema_version: z.literal(1),
  report_id: uuid,
  content_sha256: digest,
  decision: z.literal('approved'),
  reviewer: z.strictObject({ id: uuid, display_name: z.string().min(1).max(200) }),
  reviewed_at: date,
});

export interface ReviewedTechnicalInput {
  sourceText: string;
  sourceSha256: string;
  documentText: string;
  documentSha256: string;
  reviewText: string;
  reviewSha256: string;
  reportId: string;
  requestId: string;
  tenantId: string;
  planId: string;
  title: string;
}

const hash = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const escape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[character]!,
  );
function parseBounded(text: string, maxBytes: number): unknown {
  if (!text || Buffer.byteLength(text, 'utf8') > maxBytes)
    throw new Error('Unbounded technical document');
  return JSON.parse(text) as unknown;
}
function equal(value: unknown, expected: unknown) {
  if (value !== expected) throw new Error('Technical report source binding mismatch');
}

export function buildTechnicalRegisterContent(input: {
  sourceText: string;
  sourceSha256: string;
  requestId: string;
  tenantId: string;
  planId: string;
  title: string;
}) {
  equal(hash(input.sourceText), input.sourceSha256);
  const source = TechnicalSourceSchema.parse(parseBounded(input.sourceText, 4 * 1024 * 1024));
  equal(source.request_id, input.requestId);
  equal(source.tenant_id, input.tenantId);
  equal(source.plan.id, input.planId);
  if (
    new Set(source.actions.map((a) => a.id)).size !== source.actions.length ||
    new Set(source.actions.map((a) => a.sequence)).size !== source.actions.length
  )
    throw new Error('Duplicate technical action');
  if (
    source.actions.some(
      (a) =>
        (a.rollback_validation_recorded && !a.rollback_validated_at) ||
        (a.dry_run?.status === 'succeeded' && (!a.dry_run.renderable || !a.dry_run.diff_sha256)) ||
        (a.execution && !a.approval) ||
        (a.rollback_execution && !a.execution) ||
        (a.verification && !a.execution) ||
        (a.reconciliation && !a.execution),
    )
  )
    throw new Error('Inconsistent linked technical detail');
  return TechnicalContentSchema.parse({
    schema_version: 2,
    kind: 'technical_recorded_register',
    source_kind: 'recorded_remediation_plan',
    request_id: input.requestId,
    tenant_id: input.tenantId,
    plan_id: input.planId,
    source_sha256: input.sourceSha256,
    title: input.title,
    generated_by: 'technical-report-builder',
  });
}

/** Re-derive every rendered fact from frozen source bytes and the actual founder review. */
export function renderReviewedTechnicalHtml(input: ReviewedTechnicalInput): string {
  equal(hash(input.sourceText), input.sourceSha256);
  equal(hash(input.documentText), input.documentSha256);
  equal(hash(input.reviewText), input.reviewSha256);
  const source = TechnicalSourceSchema.parse(parseBounded(input.sourceText, 4 * 1024 * 1024));
  const content = TechnicalContentSchema.parse(parseBounded(input.documentText, 65536));
  const review = reviewSchema.parse(parseBounded(input.reviewText, 256 * 1024));
  const expected = buildTechnicalRegisterContent({
    sourceText: input.sourceText,
    sourceSha256: input.sourceSha256,
    requestId: input.requestId,
    tenantId: input.tenantId,
    planId: input.planId,
    title: input.title,
  });
  if (JSON.stringify(content) !== JSON.stringify(expected))
    throw new Error('Technical report content differs from frozen source');
  equal(review.report_id, input.reportId);
  equal(review.content_sha256, input.documentSha256);
  const fact = (label: string, value: string | number | boolean | null | undefined) =>
    `<dt>${escape(label)}</dt><dd>${value === null || value === undefined ? 'Not recorded' : escape(String(value))}</dd>`;
  const sections = source.actions
    .map(
      (
        a,
      ) => `<section class="action"><h2>Action ${a.sequence}: ${escape(a.action_type)}</h2><p>${escape(a.description)}</p><dl>
    ${fact('Action ID', a.id)}${fact('Risk', `${a.risk_class} (${a.risk_score})`)}
    ${fact('Parameters SHA-256', a.parameters_sha256)}${fact('Rollback definition SHA-256', a.rollback_definition_sha256)}
    ${fact('Rollback validation flag recorded', a.rollback_validation_recorded)}${fact('Rollback validated at', a.rollback_validated_at)}
    ${fact('Dry-run status', a.dry_run?.status)}${fact('Dry-run diff SHA-256', a.dry_run?.diff_sha256)}
    ${fact('Action approval status recorded', a.approval_status_recorded)}${fact('Approval token status', a.approval?.status)}${fact('Approval token ID', a.approval?.id)}
    ${fact('Execution batch status', a.execution?.batch_status)}${fact('Action execution status', a.execution?.action_status)}
    ${fact('Final outcome recorded', a.execution?.final_outcome)}${fact('Executed at', a.execution?.executed_at)}
    ${fact('Pre-state reference recorded', a.execution?.pre_state_ref_recorded)}${fact('Post-state reference recorded', a.execution?.post_state_ref_recorded)}
    ${fact('Rollback execution status', a.rollback_execution?.status)}${fact('Rollback execution ID', a.rollback_execution?.id)}
    ${fact('Verification outcome', a.verification?.outcome)}${fact('Verification evidence reference recorded', a.verification?.evidence_ref_recorded)}
    ${fact('Reconciliation ID', a.reconciliation?.id)}${fact('Unexecuted count', a.reconciliation?.unexecuted_count)}
    ${fact('Parameter difference count', a.reconciliation?.parameter_diff_count)}</dl></section>`,
    )
    .join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Recorded technical remediation register</title><style>body{font-family:Arial,sans-serif;color:#1e2a4a;margin:35px;font-size:11px}h1{font-size:22px}h2{font-size:15px}.notice{border-left:4px solid #d9534f;padding:8px;background:#fff8f7}.action{border:1px solid #cbd5e1;padding:10px;margin:12px 0;break-inside:avoid}dl{display:grid;grid-template-columns:180px 1fr;gap:4px 10px}dt{font-weight:bold}dd{margin:0;overflow-wrap:anywhere}footer{margin-top:25px;border-top:1px solid #cbd5e1;padding-top:8px}</style></head><body><h1>Recorded technical remediation register</h1><p>Report: ${escape(content.title)}</p><p>Plan: ${escape(source.plan.title)} · status ${escape(source.plan.status)} · version ${source.plan.version}</p><p>Frozen at ${escape(source.captured_at)} · source SHA-256 ${escape(input.sourceSha256)}</p><div class="notice"><strong>Scope and limitations</strong><ul>${source.limitations.map((s) => `<li>${escape(s)}</li>`).join('')}</ul></div>${sections}<footer>Founder review: ${escape(review.reviewer.display_name)} · ${escape(review.reviewed_at)} · review SHA-256 ${escape(input.reviewSha256)}. The displayed statuses are recorded source facts at capture time.</footer></body></html>`;
}
