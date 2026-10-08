import { canonicalJson } from '@axiom/ledger';
import { z } from 'zod';
import { retainedStageSource, StageUnconfirmed } from './saakshi-staging-port.js';
const time = z.iso.datetime({ offset: true });
export const evidenceStageReceiptSchema = z
  .object({
    tenant_id: retainedStageSource.shape.tenant_id,
    engagement_id: retainedStageSource.shape.engagement_id,
    operation_id: retainedStageSource.shape.operation_id,
    provider: retainedStageSource.shape.provider,
    bucket: retainedStageSource.shape.bucket,
    object_key: retainedStageSource.shape.object_key,
    content_hash: retainedStageSource.shape.content_hash,
    byte_size: retainedStageSource.shape.byte_size,
    retain_until: retainedStageSource.shape.retain_until,
    legal_hold: retainedStageSource.shape.legal_hold,
    encryption: retainedStageSource.shape.encryption,
  })
  .extend({
    correlation_id: z.uuid(),
    version_id: z
      .string()
      .min(1)
      .max(1024)
      .refine((value) => !!value.trim() && value !== 'null'),
    collected_by_agent: z.literal('saakshi'),
    readback_at: time,
    lock_mode: z.literal('COMPLIANCE'),
    verified: z.literal(true),
  })
  .strict();
export const stagedEvidenceOutputSchema = z
  .object({
    kind: z.literal('sealed_pending_registration'),
    accepted: z.literal(false),
    source: retainedStageSource,
    receipt: evidenceStageReceiptSchema,
  })
  .strict();
export function validateStagedEvidenceOutput(value: unknown, source: unknown, now = Date.now()) {
  const output = stagedEvidenceOutputSchema.parse(value);
  const expected = retainedStageSource.parse(source);
  if (canonicalJson(output.source) !== canonicalJson(expected)) throw new StageUnconfirmed();
  for (const field of [
    'tenant_id',
    'engagement_id',
    'operation_id',
    'provider',
    'bucket',
    'object_key',
    'content_hash',
    'byte_size',
    'legal_hold',
    'encryption',
  ] as const)
    if (output.receipt[field] !== expected[field]) throw new StageUnconfirmed();
  if (
    output.receipt.correlation_id !== expected.operation_key ||
    Date.parse(output.receipt.retain_until) < Date.parse(expected.retain_until) ||
    Math.abs(Date.parse(output.receipt.readback_at) - now) > 300_000
  )
    throw new StageUnconfirmed();
  return output;
}
