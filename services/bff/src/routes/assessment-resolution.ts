import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';

const uuid = z.uuid(),
  digest = z.string().regex(/^[a-f0-9]{64}$/),
  time = z.iso.datetime({ offset: true });
const receipt = z
  .union([z.number().int().positive().safe(), z.string().regex(/^[1-9][0-9]{0,18}$/)])
  .transform(String);
interface Job {
  id: string;
  tenant_id: string;
  run_id: string;
  actor_id: string;
  workload_id: string;
  estate_id: string | null;
  engagement_id: string;
  correlation_id: string;
  input_hash: string;
  claimed_at: string | null;
}
interface Run {
  status: string;
  completed_at: string | null;
  output_redacted_hash: string | null;
  error: string | null;
  metadata: Record<string, unknown>;
}

/** Persisted cancellation bindings only: never revokes or claims a task. */
export async function readAssessmentResolution(
  db: SupabaseClient,
  job: Job,
  run: Run,
  libraryVersion: string,
  hasPacket: boolean,
) {
  const read = await db
    .from('assessment_request_resolutions')
    .select(
      'job_id,tenant_id,run_id,actor_id,engagement_id,correlation_id,input_hash,library_version,requested_receipt,cancellation_receipt,resolved_at,kind',
    )
    .eq('tenant_id', job.tenant_id)
    .eq('job_id', job.id)
    .abortSignal(AbortSignal.timeout(10000))
    .maybeSingle();
  if (read.error) throw new Error('resolution unavailable');
  if (!read.data) return null;
  const row = z
    .object({
      job_id: uuid,
      tenant_id: uuid,
      run_id: uuid,
      actor_id: uuid,
      engagement_id: uuid,
      correlation_id: uuid,
      input_hash: digest,
      library_version: z.string().min(1),
      requested_receipt: receipt,
      cancellation_receipt: receipt,
      resolved_at: time,
      kind: z.literal('cancelled_unclaimed'),
    })
    .parse(read.data);
  if (
    row.job_id !== job.id ||
    row.tenant_id !== job.tenant_id ||
    row.run_id !== job.run_id ||
    row.actor_id !== job.actor_id ||
    row.engagement_id !== job.engagement_id ||
    row.correlation_id !== job.correlation_id ||
    row.correlation_id !== job.id ||
    row.input_hash !== job.input_hash ||
    row.library_version !== libraryVersion ||
    job.claimed_at !== null ||
    run.status !== 'cancelled' ||
    run.completed_at !== row.resolved_at ||
    run.output_redacted_hash !== null ||
    run.error !== null ||
    hasPacket ||
    row.requested_receipt === row.cancellation_receipt ||
    run.metadata.request_kind !== 'durable_assessment_v1' ||
    run.metadata.assessment_request_receipt !== row.requested_receipt
  )
    throw new Error('resolution inconsistent');
  const [taskRead, ledgerRead] = await Promise.all([
    db
      .from('workload_task_delegations')
      .select(
        'run_id,tenant_id,workload_identity_id,agent_name,created_by,estate_id,engagement_id,correlation_id,input_hash,revoked_at',
      )
      .eq('tenant_id', job.tenant_id)
      .eq('run_id', job.run_id)
      .abortSignal(AbortSignal.timeout(10000))
      .single(),
    db
      .from('audit_ledger')
      .select(
        'id,sequence_no,tenant_id,correlation_id,actor_type,actor_id,action_type,target_ref,input_hash,output_hash,result,detail',
      )
      .eq('tenant_id', job.tenant_id)
      .in('id', [row.requested_receipt, row.cancellation_receipt])
      .abortSignal(AbortSignal.timeout(10000)),
  ]);
  if (taskRead.error || ledgerRead.error) throw new Error('resolution unavailable');
  const task = z
    .object({
      run_id: uuid,
      tenant_id: uuid,
      workload_identity_id: uuid,
      agent_name: z.literal('parikshan'),
      created_by: uuid,
      estate_id: uuid.nullable(),
      engagement_id: uuid,
      correlation_id: uuid,
      input_hash: digest,
      revoked_at: time,
    })
    .parse(taskRead.data);
  if (
    task.run_id !== job.run_id ||
    task.tenant_id !== job.tenant_id ||
    task.workload_identity_id !== job.workload_id ||
    task.created_by !== job.actor_id ||
    task.estate_id !== job.estate_id ||
    task.engagement_id !== job.engagement_id ||
    task.correlation_id !== job.correlation_id ||
    task.input_hash !== job.input_hash ||
    task.revoked_at !== row.resolved_at
  )
    throw new Error('task inconsistent');
  const entries = z
    .array(
      z.object({
        id: receipt,
        sequence_no: receipt,
        tenant_id: uuid,
        correlation_id: uuid,
        actor_type: z.literal('human'),
        actor_id: uuid,
        action_type: z.string(),
        target_ref: z.string(),
        input_hash: digest,
        output_hash: z.null(),
        result: z.string(),
        detail: z.record(z.string(), z.unknown()),
      }),
    )
    .length(2)
    .parse(ledgerRead.data);
  const original = entries.find((e) => e.id === row.requested_receipt),
    cancelled = entries.find((e) => e.id === row.cancellation_receipt);
  if (
    !original ||
    !cancelled ||
    BigInt(original.sequence_no) >= BigInt(cancelled.sequence_no) ||
    entries.some(
      (e) =>
        e.tenant_id !== job.tenant_id ||
        e.correlation_id !== job.id ||
        e.actor_id !== job.actor_id ||
        e.target_ref !== job.id ||
        e.input_hash !== job.input_hash ||
        e.detail.job_id !== job.id ||
        e.detail.run_id !== job.run_id ||
        e.detail.workload_id !== job.workload_id ||
        e.detail.engagement_id !== job.engagement_id ||
        e.detail.library_version !== libraryVersion,
    ) ||
    original.action_type !== 'assessment.requested' ||
    original.result !== 'pending' ||
    original.detail.purpose !== 'durable_assessment' ||
    (original.detail.estate_id ?? null) !== job.estate_id ||
    cancelled.action_type !== 'assessment.request_cancelled' ||
    cancelled.result !== 'success' ||
    cancelled.detail.purpose !== 'cancel_unclaimed_assessment' ||
    cancelled.detail.resolution !== 'cancelled_unclaimed' ||
    cancelled.detail.requested_receipt !== row.requested_receipt
  )
    throw new Error('receipt inconsistent');
  return {
    actorId: row.actor_id,
    requestedReceipt: row.requested_receipt,
    cancellationReceipt: row.cancellation_receipt,
    resolvedAt: row.resolved_at,
    verification: 'persisted_human_unclaimed_cancellation_bindings' as const,
    workerCleanupVerified: false as const,
  };
}
