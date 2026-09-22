import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { AgentName } from '@axiom/types';
import { z } from 'zod';
import { WorkloadTaskAuthority, WorkloadTaskRefused } from './tasks.js';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const authorization = z
  .object({
    tenantId: z.uuid(),
    runId: z.uuid(),
    workloadProof: z.string().min(1).max(16384),
    taskProof: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  })
  .strict();
const finding = z
  .object({
    control_id: z.string().min(1).max(200),
    score: z.number().min(0).max(100),
    risk_points: z.number().min(0).max(99999.99),
    rationale: z.string().min(1).max(4000),
  })
  .strict();
export const assessmentResult = z
  .object({
    library_version: z.string().min(1).max(200),
    posture_score: z.number().min(0).max(100),
    estimated_exposure_inr: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    findings: z.array(finding).min(1).max(500),
  })
  .strict();
const startRequest = z.object({ authorization, inputHash: digest }).strict();
const completeRequest = z
  .object({
    authorization,
    libraryDigest: digest,
    result: assessmentResult,
  })
  .strict();
const packetSchema = z
  .object({
    engagement_id: z.uuid(),
    library_version: z.string().min(1).max(200),
    library_digest: digest,
    controls: z.array(z.record(z.string(), z.unknown())).min(1).max(500),
    started_receipt: z.string().regex(/^[1-9][0-9]*$/),
  })
  .strict();
const receiptSchema = z
  .object({
    completed_receipt: z.string().regex(/^[1-9][0-9]*$/),
    result_digest: digest,
  })
  .strict();

/** Private, fixed-purpose tools. Each call authenticates the current SVID,
 * registration and delegated task. SQL repeats live context checks and locks
 * through the atomic write. No caller may select an agent, RPC or database table.
 * Neither credentials nor raw adapter errors leave this boundary. */
export class AssessmentTools {
  constructor(
    private readonly authority: Pick<WorkloadTaskAuthority, 'authorize'>,
    private readonly db: SupabaseClient,
  ) {}
  async start(request: unknown) {
    try {
      const input = startRequest.parse(request);
      const task = await this.authority.authorize(
        { ...input.authorization, agentName: AgentName.PARIKSHAN },
        'control_library.read',
      );
      if (!task.engagementId || task.inputHash !== input.inputHash) throw new WorkloadTaskRefused();
      const { data, error } = await this.db.rpc('start_workload_assessment', {
        ...this.arguments(input.authorization.taskProof, task),
        p_input_hash: task.inputHash,
      });
      if (error) throw new WorkloadTaskRefused();
      const packet = packetSchema.parse(data);
      if (packet.engagement_id !== task.engagementId) throw new WorkloadTaskRefused();
      return packet;
    } catch {
      throw new WorkloadTaskRefused();
    }
  }
  async complete(request: unknown) {
    try {
      const input = completeRequest.parse(request);
      const task = await this.authority.authorize(
        { ...input.authorization, agentName: AgentName.PARIKSHAN },
        'findings.write',
      );
      if (!task.engagementId) throw new WorkloadTaskRefused();
      const { data, error } = await this.db.rpc('complete_workload_assessment', {
        ...this.arguments(input.authorization.taskProof, task),
        p_library_digest: input.libraryDigest,
        p_result: input.result,
      });
      if (error) throw new WorkloadTaskRefused();
      return receiptSchema.parse(data);
    } catch {
      throw new WorkloadTaskRefused();
    }
  }
  private arguments(proof: string, task: Awaited<ReturnType<WorkloadTaskAuthority['authorize']>>) {
    if (task.expiresAt <= Date.now()) throw new WorkloadTaskRefused();
    return {
      p_tenant_id: task.tenantId,
      p_run_id: task.runId,
      p_workload_id: task.workloadId,
      p_proof_hash: createHash('sha256').update(proof, 'ascii').digest('hex'),
      p_identity_expires_at: new Date(task.expiresAt).toISOString(),
    };
  }
}
