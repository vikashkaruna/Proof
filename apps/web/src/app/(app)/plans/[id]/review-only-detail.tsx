import Link from 'next/link';
import { PageHeader } from '@axiom/ui';
import { moduleBarProps } from '@/lib/module-bar';
import {
  persistedSudhaarReviewTasksSchema,
  sudhaarReviewAdoptionReceiptSchema,
} from '@axiom/types';
import type { SupabaseClient } from '@supabase/supabase-js';
export async function ReviewOnlyDetail({
  supabase,
  tenantId,
  planId,
  title,
}: {
  supabase: SupabaseClient;
  tenantId: string;
  planId: string;
  title: string;
}) {
  const [binding, tasks] = await Promise.all([
    supabase
      .from('plan_source_review_adoptions')
      .select('*')
      .eq('tenant_id', tenantId)
      .eq('plan_id', planId)
      .single(),
    supabase
      .from('plan_source_review_tasks')
      .select('sequence,task')
      .eq('tenant_id', tenantId)
      .eq('plan_id', planId)
      .order('sequence', { ascending: true })
      .limit(501),
  ]);
  const row = binding.data;
  const receipt = sudhaarReviewAdoptionReceiptSchema.safeParse(
    row && {
      tenantId: row.tenant_id,
      actorId: row.actor_id,
      proposalOperationKey: row.proposal_operation_key,
      adoptionKey: row.adoption_key,
      planId: row.plan_id,
      requestHash: row.request_hash,
      adoptionReceipt: row.adoption_receipt_text,
      purpose: 'source_review',
      status: 'review',
      taskCount: row.task_count,
      actionCount: 0,
      executionAllowed: false,
      source: row.source,
      outputProof: row.output_proof,
    },
  );
  const parsed = persistedSudhaarReviewTasksSchema.safeParse(tasks.data?.map((row) => row.task));
  const valid =
    !binding.error &&
    !tasks.error &&
    receipt.success &&
    parsed.success &&
    receipt.data.tenantId === tenantId &&
    receipt.data.planId === planId &&
    parsed.data.length === receipt.data.taskCount &&
    tasks.data?.every((row, index) => row.sequence === parsed.data[index]?.sequence);
  return (
    <section className="w-full min-w-0 space-y-4" aria-label="Saved review work">
      <PageHeader
        module={moduleBarProps('remediation')}
        title={title}
        description="Review-only work saved by a human. No corrective actions, approval or execution authority."
      />
      <Link href="/plans">Back to plans</Link>
      {!valid ? (
        <p role="alert">
          Recorded review tasks or their source receipt are unavailable. No review readiness can be
          inferred.
        </p>
      ) : (
        <>
          <p>
            {receipt.data.taskCount} review tasks · 0 corrective actions · Execution unavailable
          </p>
          <p className="break-all">
            Human adoption receipt {receipt.data.adoptionReceipt} · Proposal run{' '}
            {receipt.data.outputProof.runId} · Source assessment{' '}
            {receipt.data.source.assessmentRunId} · Library {receipt.data.source.libraryVersion}
          </p>
          <p>
            These tasks preserve the assessment declarations for human review. They do not verify
            compliance or close findings.
          </p>
          <p>Reason: {row?.reason}</p>
          <ol className="space-y-3">
            {parsed.data.map((task) => (
              <li key={task.finding_id} className="rounded-md border p-3">
                <strong>
                  {task.sequence}. {task.title}
                </strong>
                <p>
                  Control {task.control_id} · {task.reason.replaceAll('_', ' ')}
                </p>
                <p>{task.instruction}</p>
              </li>
            ))}
          </ol>
        </>
      )}
    </section>
  );
}
