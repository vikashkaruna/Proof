import Link from 'next/link';
import { Capability } from '@axiom/types';
import { PageHeader, Stat, StatGrid } from '@axiom/ui';
import { requireCapabilityContext } from '@/lib/tenant-context';
import { isBatchOpen, needsOperatorAttention } from '@/lib/execution-view';
import {
  BatchCard,
  type BatchActionRow,
  type BatchDetail,
  type BatchRollbackRow,
  type ReconciliationRow,
  type BatchVerificationRow,
  type BatchRow,
} from './batch-card';

export const dynamic = 'force-dynamic';

const BATCH_LIMIT = 20;

/**
 * W5 execution surface: the recorded reality of the execution engine.
 *
 * Reads the execution-detail tables (migrations 0060-0063) through the
 * user-scoped client — RLS is the tenancy backstop, so a missing filter is an
 * empty result, not a leak. Every figure on this page is a recorded outcome
 * written by the executor's SECURITY DEFINER paths; nothing is sampled or
 * predicted. Live in-batch streaming (`execution.progress`) is not shown
 * because the app holds no realtime subscription; a refresh after the execute
 * route's response re-renders this page from recorded state.
 */
export default async function ExecutionPage() {
  const { supabase, tenantId } = await requireCapabilityContext(Capability.PLAN_EXECUTE);

  const batchesRes = await supabase
    .from('execution_batches')
    .select(
      `id, plan_id, request_key, correlation_id, content_digest, mode, concurrency,
       stop_on_failure, status, dispatch_reference, started_at, finished_at,
       remediation_plans (title)`,
    )
    .eq('tenant_id', tenantId)
    .order('started_at', { ascending: false })
    .limit(BATCH_LIMIT);

  const batches = (batchesRes.data ?? []) as unknown as BatchRow[];
  const batchIds = batches.map((b) => b.id);

  const emptyOk = { data: [] as never[], error: null };
  const [actionsRes, rollbacksRes, verificationsRes, reconciliationsRes] = await Promise.all([
    batchIds.length > 0
      ? supabase
          .from('remediation_actions')
          .select(
            `id, sequence, action_type, description, execution_status, final_outcome,
             executed_at, pre_state_uri, post_state_uri, execution_batch_id`,
          )
          .eq('tenant_id', tenantId)
          .in('execution_batch_id', batchIds)
          .order('sequence')
      : Promise.resolve(emptyOk),
    batchIds.length > 0
      ? supabase
          .from('rollback_executions')
          .select(
            `id, action_id, batch_id, definition_hash, triggered_by, status, result,
             executed_by_agent, started_at, finished_at`,
          )
          .eq('tenant_id', tenantId)
          .in('batch_id', batchIds)
          .order('started_at', { ascending: false })
      : Promise.resolve(emptyOk),
    batchIds.length > 0
      ? supabase
          .from('verification_results')
          .select(
            `id, action_id, batch_id, checks, outcome, evidence_uri, verified_by_agent, verified_at`,
          )
          .eq('tenant_id', tenantId)
          .in('batch_id', batchIds)
          .order('verified_at', { ascending: false })
      : Promise.resolve(emptyOk),
    batchIds.length > 0
      ? supabase
          .from('plan_reconciliations')
          .select(
            `id, plan_id, batch_id, approved_scope, executed_reality, unexecuted,
             parameter_diffs, verification_outcomes, statement, statement_signature, created_at`,
          )
          .eq('tenant_id', tenantId)
          .in('batch_id', batchIds)
          .order('created_at', { ascending: false })
      : Promise.resolve(emptyOk),
  ]);

  if (batchesRes.error) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader
          title="Execution & Rollback"
          description="Batches, per-action outcomes, rollback state and reconciliation verdicts, as recorded by the executor."
        />
        <p
          role="alert"
          className="rounded-md border border-ember-500 bg-ember-50 p-4 text-sm text-ember-700"
        >
          Execution records could not be loaded. Refresh to try again.
        </p>
      </div>
    );
  }

  const actions = (actionsRes.data ?? []) as unknown as BatchActionRow[];
  const rollbacks = (rollbacksRes.data ?? []) as unknown as BatchRollbackRow[];
  const verifications = (verificationsRes.data ?? []) as unknown as BatchVerificationRow[];
  const reconciliations = (reconciliationsRes.data ?? []) as unknown as ReconciliationRow[];

  const actionsByBatch = groupBy(actions, (a) => a.execution_batch_id);
  const rollbacksByBatch = groupBy(rollbacks, (r) => r.batch_id);
  const verificationsByBatch = groupBy(verifications, (v) => v.batch_id);
  const reconciliationByBatch = new Map(reconciliations.map((r) => [r.batch_id, r]));

  const open = batches.filter((b) => isBatchOpen(b.status)).length;
  const attention = batches.filter((b) => needsOperatorAttention(b.status)).length;
  const failedActions = actions.filter((a) => a.final_outcome === 'failed').length;
  const failedRollbacks = rollbacks.filter((r) => r.status !== 'succeeded').length;

  const details: BatchDetail[] = batches.map((batch) => ({
    batch,
    actions: actionsByBatch.get(batch.id) ?? [],
    rollbacks: rollbacksByBatch.get(batch.id) ?? [],
    verifications: verificationsByBatch.get(batch.id) ?? [],
    reconciliation: reconciliationByBatch.get(batch.id) ?? null,
  }));

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Execution & Rollback"
        description="What Karya actually did: batches with per-action outcomes, halts and rollbacks, Parikshan's post-execution verification, and the signed maker-checker reconciliation. Actions execute only against a signed approval token — this page shows the recorded outcome."
        actions={
          <Link
            href="/plans"
            className="rounded-md border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-700 hover:bg-mist-50"
          >
            Remediation plans →
          </Link>
        }
      />

      <StatGrid>
        <Stat
          label="Recent batches"
          value={String(batches.length)}
          hint={open > 0 ? `${open} still in flight` : 'none in flight'}
        />
        <Stat
          label="Need review"
          value={String(attention)}
          hint="halted, failed or partial batches"
        />
        <Stat
          label="Failed actions"
          value={String(failedActions)}
          hint="settled with a failed outcome"
        />
        <Stat
          label="Failed rollbacks"
          value={String(failedRollbacks)}
          hint="an undo that did not complete — never clean"
        />
      </StatGrid>

      {batches.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-slate-300 bg-mist-50 p-10 text-center">
          <h2 className="font-heading text-sm font-semibold text-indigo-500">
            No execution batches yet
          </h2>
          <p className="mx-auto mt-1.5 max-w-md text-xs leading-relaxed text-slate-500">
            A batch appears here when approved actions are executed through the execution gate.
            Until then there is nothing to show — deliberately: this page records what ran, never
            what might.
          </p>
          <Link
            href="/approval"
            className="mt-3 inline-block text-xs font-medium text-teal-700 underline"
          >
            Go to the approval console →
          </Link>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {details.map((detail) => (
            <BatchCard key={detail.batch.id} detail={detail} />
          ))}
        </div>
      )}
    </div>
  );
}

function groupBy<T>(rows: T[], key: (row: T) => string | null): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const k = key(row);
    if (!k) continue;
    const list = map.get(k);
    if (list) list.push(row);
    else map.set(k, [row]);
  }
  return map;
}
