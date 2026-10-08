import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';

export interface OriginalAssessmentJob {
  id: string;
  tenant_id: string;
  run_id: string;
  actor_id: string;
  workload_id: string;
  estate_id: string | null;
  engagement_id: string;
  correlation_id: string;
  input_hash: string;
}
export interface OriginalAssessmentRun {
  id: string;
  tenant_id: string;
  agent: string;
  engagement_id: string | null;
  correlation_id: string;
  input_redacted_hash: string | null;
  metadata: Record<string, unknown>;
}
const receipt = z
  .union([z.number().int().positive().safe(), z.string().regex(/^[1-9][0-9]{0,18}$/)])
  .transform(String);

/** The immutable human request pins its library; current engagement settings are not recovery authority. */
export async function readOriginalAssessmentRequest(
  db: SupabaseClient,
  job: OriginalAssessmentJob,
  run: OriginalAssessmentRun,
) {
  if (
    run.metadata.request_kind === undefined &&
    run.metadata.assessment_request_receipt === undefined
  )
    return null; // Existing pre-human-enqueue jobs remain readable without inventing a human request.
  const receiptId = receipt.parse(run.metadata.assessment_request_receipt);
  if (
    run.metadata.request_kind !== 'durable_assessment_v1' ||
    job.correlation_id !== job.id ||
    run.id !== job.run_id ||
    run.tenant_id !== job.tenant_id ||
    run.agent !== 'parikshan' ||
    run.engagement_id !== job.engagement_id ||
    run.correlation_id !== job.correlation_id ||
    run.input_redacted_hash !== job.input_hash
  )
    throw new Error('original request context inconsistent');
  const read = await db
    .from('audit_ledger')
    .select(
      'id,tenant_id,correlation_id,actor_type,actor_id,action_type,target_ref,input_hash,output_hash,result,detail',
    )
    .eq('tenant_id', job.tenant_id)
    .eq('id', receiptId)
    .abortSignal(AbortSignal.timeout(10000))
    .single();
  if (read.error) throw new Error('original request unavailable');
  const entry = z
    .object({
      id: receipt,
      tenant_id: z.uuid(),
      correlation_id: z.uuid(),
      actor_type: z.literal('human'),
      actor_id: z.uuid(),
      action_type: z.literal('assessment.requested'),
      target_ref: z.uuid(),
      input_hash: z.string().regex(/^[a-f0-9]{64}$/),
      output_hash: z.null(),
      result: z.literal('pending'),
      detail: z.object({
        purpose: z.literal('durable_assessment'),
        job_id: z.uuid(),
        run_id: z.uuid(),
        workload_id: z.uuid(),
        estate_id: z.uuid().nullable(),
        engagement_id: z.uuid(),
        library_version: z.string().min(1).max(200),
      }),
    })
    .parse(read.data);
  if (
    entry.id !== receiptId ||
    entry.tenant_id !== job.tenant_id ||
    entry.actor_id !== job.actor_id ||
    entry.correlation_id !== job.id ||
    entry.target_ref !== job.id ||
    entry.input_hash !== job.input_hash ||
    entry.detail.job_id !== job.id ||
    entry.detail.run_id !== job.run_id ||
    entry.detail.workload_id !== job.workload_id ||
    entry.detail.estate_id !== job.estate_id ||
    entry.detail.engagement_id !== job.engagement_id
  )
    throw new Error('original human receipt inconsistent');
  return { libraryVersion: entry.detail.library_version, requestedReceipt: entry.id };
}
