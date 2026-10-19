import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { coveragePresentation } from '@axiom/types';
import type {
  OriginalAssessmentJob,
  OriginalAssessmentRun,
} from '../routes/assessment-original-request.js';
const uuid = z.uuid(),
  hash = z.string().regex(/^[a-f0-9]{64}$/),
  receipt = z.string().regex(/^[1-9][0-9]{0,18}$/);
export async function readScheduledCoverageOriginal(
  db: SupabaseClient,
  job: OriginalAssessmentJob,
  run: OriginalAssessmentRun,
) {
  if (run.metadata.request_kind !== 'scheduled_coverage_reassessment_v1')
    throw Error('Scheduled coverage source required');
  const { data, error } = await db
    .rpc('read_scheduled_coverage_original_request', {
      p_tenant_id: job.tenant_id,
      p_job_id: job.id,
    })
    .abortSignal(AbortSignal.timeout(5000));
  if (error) throw Error('Scheduled coverage source unavailable');
  const proof = z
    .object({
      tenantId: uuid,
      jobId: uuid,
      runId: uuid,
      ownerId: uuid,
      workloadId: uuid,
      estateId: uuid,
      engagementId: uuid,
      correlationId: uuid,
      inputSha256: hash,
      requestedReceipt: receipt,
      libraryVersion: z.string().min(1).max(200),
      fireId: uuid,
      scopeId: uuid,
      scopeReceiptId: receipt,
    })
    .strict()
    .parse(data);
  if (
    proof.tenantId !== job.tenant_id ||
    proof.jobId !== job.id ||
    proof.runId !== job.run_id ||
    proof.ownerId !== job.actor_id ||
    proof.workloadId !== job.workload_id ||
    proof.estateId !== job.estate_id ||
    proof.engagementId !== job.engagement_id ||
    proof.correlationId !== job.correlation_id ||
    proof.inputSha256 !== job.input_hash ||
    proof.runId !== run.id ||
    proof.tenantId !== run.tenant_id ||
    proof.engagementId !== run.engagement_id ||
    proof.correlationId !== run.correlation_id ||
    proof.inputSha256 !== run.input_redacted_hash ||
    run.agent !== 'parikshan' ||
    proof.requestedReceipt !== run.metadata.assessment_request_receipt ||
    proof.fireId !== run.metadata.scheduled_coverage_fire_id ||
    proof.scopeId !== run.metadata.scheduled_coverage_scope_id
  )
    throw Error('Scheduled coverage source binding refused');
  return proof;
}
export async function readScheduledCoveragePresentation(
  db: SupabaseClient,
  tenantId: string,
  runId: string,
  engagementId: string,
) {
  const { data, error } = await db
    .rpc('read_scheduled_coverage_presentation', {
      p_tenant_id: uuid.parse(tenantId),
      p_run_id: uuid.parse(runId),
    })
    .abortSignal(AbortSignal.timeout(5000));
  if (error) throw Error('Scheduled coverage presentation unavailable');
  const value = coveragePresentation.parse(data);
  if (value.tenantId !== tenantId || value.runId !== runId || value.engagementId !== engagementId)
    throw Error('Scheduled coverage presentation binding refused');
  return value;
}
