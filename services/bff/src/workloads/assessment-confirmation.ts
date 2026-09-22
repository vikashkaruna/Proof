import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { assessmentResult } from './assessment-tools.js';
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const expectedSchema = z
  .object({
    tenantId: z.uuid(),
    runId: z.uuid(),
    engagementId: z.uuid(),
    correlationId: z.uuid(),
    inputHash: digest,
  })
  .strict();
export type AssessmentConfirmationContext = z.infer<typeof expectedSchema>;
const confirmedSchema = z
  .object({
    run_id: z.uuid(),
    tenant_id: z.uuid(),
    agent: z.literal('parikshan'),
    engagement_id: z.uuid(),
    correlation_id: z.uuid(),
    status: z.literal('succeeded'),
    input_hash: digest,
    result_digest: digest,
    completed_at: z.iso.datetime({ offset: true }),
    completed_receipt: z.string().regex(/^[1-9][0-9]*$/),
    finalized_receipt: z.string().regex(/^[1-9][0-9]*$/),
    result: assessmentResult,
  })
  .strict();
export class AssessmentCompletionUnconfirmed extends Error {
  constructor() {
    super('Assessment completion could not be confirmed.');
    this.name = 'AssessmentCompletionUnconfirmed';
  }
}
/** Trusted controller/recovery path only; intentionally not a worker tool or
 * browser route. Independently checks SQL-persisted receipts, never a worker's
 * exit/status claim. Can record past committed truth after a task has expired;
 * cannot grant a fresh task or override terminal cancellations/conflicts. */
export class AssessmentConfirmation {
  constructor(private readonly db: SupabaseClient) {}
  async confirm(expected: AssessmentConfirmationContext) {
    try {
      const context = expectedSchema.parse(expected);
      const { data, error } = await this.db.rpc('confirm_workload_assessment', {
        p_tenant_id: context.tenantId,
        p_run_id: context.runId,
      });
      if (error) throw new AssessmentCompletionUnconfirmed();
      const recorded = confirmedSchema.parse(data);
      if (
        recorded.tenant_id !== context.tenantId ||
        recorded.run_id !== context.runId ||
        recorded.engagement_id !== context.engagementId ||
        recorded.correlation_id !== context.correlationId ||
        recorded.input_hash !== context.inputHash ||
        recorded.finalized_receipt === recorded.completed_receipt
      )
        throw new AssessmentCompletionUnconfirmed();
      return recorded;
    } catch {
      throw new AssessmentCompletionUnconfirmed();
    }
  }
}
