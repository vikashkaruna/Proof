import { Hono } from 'hono';
import { z } from 'zod';
import { createSupabaseAdmin } from '@axiom/supabase';
import { Capability } from '@axiom/types';
import { requireCapability } from '../middleware/authorize.js';
import type { Variables } from '../types.js';
import { readAssessmentResolution } from './assessment-resolution.js';
import { readOriginalAssessmentRequest } from './assessment-original-request.js';

const uuid = z.uuid();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const timestamp = z.iso.datetime({ offset: true });
const receiptId = z
  .union([z.string().regex(/^[1-9][0-9]*$/), z.number().int().positive().safe()])
  .transform(String);
const jobSchema = z.object({
  id: uuid,
  tenant_id: uuid,
  run_id: uuid,
  workload_id: uuid,
  actor_id: uuid,
  estate_id: uuid.nullable().default(null),
  engagement_id: uuid,
  correlation_id: uuid,
  input_hash: digest,
  created_at: timestamp,
  claimed_at: timestamp.nullable(),
  scheduling_status: z.enum(['pending', 'submitted', 'needs_review']),
});
const runSchema = z.object({
  id: uuid,
  tenant_id: uuid,
  agent: z.literal('parikshan'),
  engagement_id: uuid,
  correlation_id: uuid,
  status: z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled', 'timed_out']),
  input_redacted_hash: digest,
  output_redacted_hash: digest.nullable(),
  completed_at: timestamp.nullable(),
  error: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
const packetSchema = z.object({
  run_id: uuid,
  tenant_id: uuid,
  engagement_id: uuid,
  library_version: z.string().min(1),
  library_digest: digest,
  started_receipt: receiptId,
  completed_receipt: receiptId.nullable(),
  finalized_receipt: receiptId.nullable(),
  result_digest: digest.nullable(),
  completed_at: timestamp.nullable(),
  finalized_at: timestamp.nullable(),
});
const ledgerSchema = z.object({
  id: receiptId,
  sequence_no: receiptId,
  tenant_id: uuid,
  correlation_id: uuid,
  actor_type: z.string(),
  actor_id: z.string(),
  action_type: z.string(),
  target_ref: z.string(),
  input_hash: digest,
  output_hash: digest.nullable(),
  result: z.string(),
  detail: z.record(z.string(), z.unknown()),
});
const unavailable = {
  error: {
    code: 'assessment_status_unavailable',
    message: 'Assessment job status could not be verified.',
  },
};

/** Read-only projection of an existing dispatch and controller finalization.
 * Never claims, launches, decrypts, confirms or finalizes a task. A generic
 * runtime success or scheduler acknowledgement is not durable finalization. */
export function assessmentJobStatusRoutes() {
  const app = new Hono<{ Variables: Variables }>();
  app.get('/assessment/jobs/:jobId', async (c) => {
    c.header('Cache-Control', 'private, no-store');
    const denied = requireCapability(c, Capability.POSTURE_READ);
    if (denied) return denied;
    const parsed = uuid.safeParse(c.req.param('jobId'));
    if (!parsed.success || [...new URL(c.req.url).searchParams].length)
      return c.json({ error: { code: 'invalid_assessment_job' } }, 400);
    const tenantId = c.get('tenantId').toLowerCase();
    const jobId = parsed.data.toLowerCase();
    try {
      const db = createSupabaseAdmin();
      const jobRead = await db
        .from('assessment_dispatch_jobs')
        .select(
          'id,tenant_id,run_id,workload_id,actor_id,estate_id,engagement_id,correlation_id,input_hash,created_at,claimed_at,scheduling_status',
        )
        .eq('tenant_id', tenantId)
        .eq('id', jobId)
        .abortSignal(AbortSignal.timeout(10000))
        .maybeSingle();
      if (jobRead.error) return c.json(unavailable, 503);
      if (!jobRead.data) return c.json({ error: { code: 'assessment_job_not_found' } }, 404);
      const job = jobSchema.parse(jobRead.data);
      if (job.tenant_id !== tenantId || job.id !== jobId) return c.json(unavailable, 503);
      const [runRead, packetRead, engagementRead] = await Promise.all([
        db
          .from('agent_runs')
          .select(
            'id,tenant_id,agent,engagement_id,correlation_id,status,input_redacted_hash,output_redacted_hash,completed_at,error,metadata',
          )
          .eq('tenant_id', tenantId)
          .eq('id', job.run_id)
          .abortSignal(AbortSignal.timeout(10000))
          .maybeSingle(),
        db
          .from('workload_assessment_packets')
          .select(
            'run_id,tenant_id,engagement_id,library_version,library_digest,started_receipt,completed_receipt,finalized_receipt,result_digest,completed_at,finalized_at',
          )
          .eq('tenant_id', tenantId)
          .eq('run_id', job.run_id)
          .abortSignal(AbortSignal.timeout(10000))
          .maybeSingle(),
        db
          .from('engagements')
          .select('id,tenant_id,library_version')
          .eq('tenant_id', tenantId)
          .eq('id', job.engagement_id)
          .abortSignal(AbortSignal.timeout(10000))
          .maybeSingle(),
      ]);
      if (runRead.error || packetRead.error || engagementRead.error)
        return c.json(unavailable, 503);
      const run = runSchema.parse(runRead.data);
      const engagement = z
        .object({ id: uuid, tenant_id: uuid, library_version: z.string().min(1) })
        .parse(engagementRead.data);
      if (
        run.tenant_id !== tenantId ||
        run.id !== job.run_id ||
        run.engagement_id !== job.engagement_id ||
        run.correlation_id !== job.correlation_id ||
        run.input_redacted_hash !== job.input_hash ||
        engagement.id !== job.engagement_id ||
        engagement.tenant_id !== tenantId
      )
        return c.json(unavailable, 503);
      const original = await readOriginalAssessmentRequest(db, job, run);
      const requestLibraryVersion = original?.libraryVersion ?? engagement.library_version;
      const packet = packetRead.data ? packetSchema.parse(packetRead.data) : null;
      if (
        packet &&
        (packet.tenant_id !== tenantId ||
          packet.run_id !== job.run_id ||
          packet.engagement_id !== job.engagement_id ||
          packet.library_version !== requestLibraryVersion)
      )
        return c.json(unavailable, 503);
      const base = {
        jobId,
        runId: run.id,
        engagementId: job.engagement_id,
        correlationId: job.correlation_id,
        libraryVersion: requestLibraryVersion,
        recordedRunStatus: run.status,
        schedulingStatus: job.scheduling_status,
        createdAt: job.created_at,
        claimedAt: job.claimed_at,
        allAgentEndToEndAccepted: false,
      };
      const resolution = await readAssessmentResolution(
        db,
        job,
        run,
        requestLibraryVersion,
        packet !== null,
      );
      if (resolution)
        return c.json({
          ...base,
          status: 'resolution_recorded',
          phase: 'cancelled_unclaimed',
          finalization: null,
          resolution,
        });
      if (!packet?.finalized_receipt)
        return c.json({
          ...base,
          status: 'unconfirmed',
          finalization: null,
          phase:
            run.status === 'queued'
              ? 'queued'
              : packet?.completed_receipt
                ? 'result_recorded'
                : run.status === 'running'
                  ? 'running'
                  : 'terminal_unconfirmed',
        });
      if (
        run.status !== 'succeeded' ||
        run.error !== null ||
        !packet.completed_receipt ||
        !packet.result_digest ||
        !packet.completed_at ||
        !packet.finalized_at ||
        run.completed_at !== packet.completed_at ||
        run.output_redacted_hash !== packet.result_digest
      )
        return c.json(unavailable, 503);
      const ids = [packet.started_receipt, packet.completed_receipt, packet.finalized_receipt];
      if (new Set(ids).size !== 3) return c.json(unavailable, 503);
      const ledgerRead = await db
        .from('audit_ledger')
        .select(
          'id,sequence_no,tenant_id,correlation_id,actor_type,actor_id,action_type,target_ref,input_hash,output_hash,result,detail',
        )
        .eq('tenant_id', tenantId)
        .in('id', ids)
        .abortSignal(AbortSignal.timeout(10000));
      if (ledgerRead.error) return c.json(unavailable, 503);
      const entries = z.array(ledgerSchema).length(3).parse(ledgerRead.data);
      const [start, complete, final] = ids.map((id) => entries.find((entry) => entry.id === id));
      if (
        !start ||
        !complete ||
        !final ||
        !(
          BigInt(start.sequence_no) < BigInt(complete.sequence_no) &&
          BigInt(complete.sequence_no) < BigInt(final.sequence_no)
        ) ||
        entries.some(
          (entry) =>
            entry.tenant_id !== tenantId ||
            entry.correlation_id !== job.correlation_id ||
            entry.input_hash !== job.input_hash,
        ) ||
        start.actor_type !== 'agent' ||
        complete.actor_type !== 'agent' ||
        start.actor_id !== 'parikshan' ||
        complete.actor_id !== 'parikshan' ||
        start.action_type !== 'assessment.started' ||
        complete.action_type !== 'assessment.scored' ||
        start.target_ref !== job.engagement_id ||
        complete.target_ref !== job.engagement_id ||
        start.result !== 'pending' ||
        complete.result !== 'success' ||
        complete.output_hash !== packet.result_digest ||
        [start, complete].some(
          (entry) =>
            entry.detail.run_id !== job.run_id ||
            entry.detail.workload_id !== job.workload_id ||
            entry.detail.library_digest !== packet.library_digest,
        ) ||
        final.actor_type !== 'system' ||
        final.actor_id !== 'assessment-controller' ||
        final.action_type !== 'workload.task_completed' ||
        final.result !== 'success' ||
        final.target_ref !== job.run_id ||
        final.output_hash !== packet.result_digest ||
        final.detail.workload_id !== job.workload_id ||
        final.detail.library_version !== packet.library_version ||
        final.detail.assessment_started_receipt !== packet.started_receipt ||
        final.detail.assessment_completed_receipt !== packet.completed_receipt
      )
        return c.json(unavailable, 503);
      return c.json({
        ...base,
        status: 'finalization_recorded',
        phase: 'finalized',
        finalization: {
          startedReceipt: packet.started_receipt,
          completedReceipt: packet.completed_receipt,
          finalizedReceipt: packet.finalized_receipt,
          resultDigest: packet.result_digest,
          completedAt: packet.completed_at,
          finalizedAt: packet.finalized_at,
          verification: 'persisted_controller_receipt_bindings',
        },
      });
    } catch {
      return c.json(unavailable, 503);
    }
  });
  return app;
}
