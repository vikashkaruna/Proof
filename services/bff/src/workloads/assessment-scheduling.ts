import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
const namespace = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/);
const workflowId = z.string().regex(/^assessment-[a-f0-9-]{36}-[a-f0-9-]{36}$/);
export const schedulingTicket = z
  .object({
    tenantId: z.uuid(),
    jobId: z.uuid(),
    namespace,
    workflowId,
    leaseId: z.uuid(),
    leaseUntil: z.iso.datetime({ offset: true }),
    startBefore: z.iso.datetime({ offset: true }).nullable(),
  })
  .strict();
export const schedulingAcknowledgement = z
  .object({
    tenantId: z.uuid(),
    jobId: z.uuid(),
    leaseId: z.uuid(),
    namespace,
    workflowId,
    workflowRunId: z.uuid(),
  })
  .strict();
export const schedulingReceipt = schedulingAcknowledgement
  .omit({ leaseId: true })
  .extend({ receipt: z.string().regex(/^[1-9][0-9]*$/) })
  .strict();
const binding = (job: { tenantId: string; jobId: string; workflowId: string }) =>
  job.workflowId === `assessment-${job.tenantId}-${job.jobId}`;
export class AssessmentScheduling {
  readonly namespace: string;
  private readonly tenantId: string | null;
  constructor(
    private readonly db: SupabaseClient,
    options: { namespace: string; tenantId?: string },
  ) {
    this.namespace = namespace.parse(options.namespace);
    this.tenantId = options.tenantId ? z.uuid().parse(options.tenantId).toLowerCase() : null;
  }
  async reserve() {
    try {
      const { data, error } = await this.db.rpc('reserve_assessment_schedules', {
        p_namespace: this.namespace,
        p_tenant_id: this.tenantId,
        p_limit: 1,
      });
      if (error) throw new Error();
      const value = z
        .object({ jobs: z.array(schedulingTicket).max(1) })
        .strict()
        .parse(data);
      if (
        value.jobs.some(
          (job) =>
            !binding(job) ||
            job.namespace !== this.namespace ||
            (this.tenantId && job.tenantId !== this.tenantId) ||
            Date.parse(job.leaseUntil) <= Date.now(),
        )
      )
        throw new Error();
      return value;
    } catch {
      throw new Error('Assessment scheduling unavailable');
    }
  }
  async acknowledge(request: unknown) {
    try {
      const job = schedulingAcknowledgement.parse(request);
      if (
        !binding(job) ||
        job.namespace !== this.namespace ||
        (this.tenantId && job.tenantId !== this.tenantId)
      )
        throw new Error();
      const { data, error } = await this.db.rpc('acknowledge_assessment_schedule', {
        p_tenant_id: job.tenantId,
        p_job_id: job.jobId,
        p_lease_id: job.leaseId,
        p_namespace: job.namespace,
        p_workflow_id: job.workflowId,
        p_workflow_run_id: job.workflowRunId,
      });
      if (error) throw new Error();
      const value = schedulingReceipt.parse(data);
      if (
        value.tenantId !== job.tenantId ||
        value.jobId !== job.jobId ||
        value.namespace !== job.namespace ||
        value.workflowId !== job.workflowId ||
        value.workflowRunId !== job.workflowRunId
      )
        throw new Error();
      return value;
    } catch {
      throw new Error('Assessment scheduling unavailable');
    }
  }
}
