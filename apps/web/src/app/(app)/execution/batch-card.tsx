import Link from 'next/link';
import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  ProofSeal,
  StatusBadge,
  type StatusKind,
} from '@axiom/ui';
import { formatDateTime, truncateHash } from '@axiom/ui';
import {
  isBatchOpen,
  needsOperatorAttention,
  reconciliationVerdict,
  summarizeVerificationOutcomes,
} from '@/lib/execution-view';

// Row shapes for the execution-detail tables (migrations 0060-0063). The
// queries run through the user-scoped Supabase client, so RLS is the
// tenancy backstop and these types describe what a permitted read returns.
export interface BatchRow {
  id: string;
  plan_id: string;
  request_key: string;
  correlation_id: string;
  content_digest: string;
  mode: string;
  concurrency: number;
  stop_on_failure: boolean;
  status: string;
  dispatch_reference: string | null;
  started_at: string;
  finished_at: string | null;
  remediation_plans: { title?: string } | null;
}

export interface BatchActionRow {
  id: string;
  sequence: number;
  action_type: string;
  description: string;
  execution_status: string | null;
  final_outcome: string | null;
  executed_at: string | null;
  pre_state_uri: string | null;
  post_state_uri: string | null;
  execution_batch_id: string | null;
}

export interface BatchRollbackRow {
  id: string;
  action_id: string;
  batch_id: string | null;
  definition_hash: string;
  triggered_by: string;
  status: string;
  result: unknown;
  executed_by_agent: string;
  started_at: string;
  finished_at: string | null;
}

export interface BatchVerificationRow {
  id: string;
  action_id: string;
  batch_id: string | null;
  checks: unknown;
  outcome: string;
  evidence_uri: string | null;
  verified_by_agent: string;
  verified_at: string;
}

export interface ReconciliationRow {
  id: string;
  plan_id: string;
  batch_id: string;
  approved_scope: {
    token_id?: string;
    nonce?: string;
    action_ids?: string[];
    content_digest?: string;
  } | null;
  executed_reality: {
    batch_status?: string;
    succeeded_at_finish?: number;
    failed_at_finish?: number;
    rolled_back?: number;
    content_digest_recomputed?: string;
  } | null;
  unexecuted: { action_id?: string; reason?: string }[];
  parameter_diffs: { kind?: string; approved?: string; recomputed?: string }[];
  verification_outcomes: Record<string, string>;
  statement: string;
  statement_signature: string;
  created_at: string;
}

export interface BatchDetail {
  batch: BatchRow;
  actions: BatchActionRow[];
  rollbacks: BatchRollbackRow[];
  verifications: BatchVerificationRow[];
  reconciliation: ReconciliationRow | null;
}

const ROLLBACK_TRIGGERS: Record<string, string> = {
  failure_threshold: 'stop-on-failure',
  manual: 'manual',
  governor: 'blast-radius governor',
  verification: 'verification',
};

function checksCount(checks: unknown): number {
  return Array.isArray(checks) ? checks.length : 0;
}

/**
 * One execution batch with its full recorded outcome: per-action results,
 * rollback state, post-execution verification and the maker-checker
 * reconciliation statement. Everything shown was written by the executor's
 * SECURITY DEFINER paths — the page invents nothing.
 */
export function BatchCard({ detail }: { detail: BatchDetail }) {
  const { batch, actions, rollbacks, verifications, reconciliation } = detail;
  const attention = needsOperatorAttention(batch.status);
  const open = isBatchOpen(batch.status);
  const actionById = new Map(actions.map((a) => [a.id, a]));
  const settled = actions.filter((a) => a.final_outcome !== null);
  const succeeded = actions.filter((a) => a.final_outcome === 'succeeded').length;
  const failed = actions.filter((a) => a.final_outcome === 'failed').length;

  return (
    <Card
      className={
        attention
          ? 'border-ember-500'
          : batch.status === 'completed'
            ? 'border-teal-500'
            : undefined
      }
    >
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle className="text-base">
            Batch <code className="font-mono text-sm text-indigo-700">{batch.id.slice(0, 8)}</code>
          </CardTitle>
          <StatusBadge status={batch.status as StatusKind} />
          {attention && (
            <Badge variant="danger">
              {batch.status === 'halted' ? 'Halted — operator review required' : 'Operator review'}
            </Badge>
          )}
          {open && <Badge variant="info">In flight</Badge>}
        </div>
        <p className="text-xs text-slate-500">
          {batch.remediation_plans?.title ? (
            <>
              Plan:{' '}
              <Link href={`/plans/${batch.plan_id}`} className="text-teal-700 underline">
                {batch.remediation_plans.title}
              </Link>
              {' · '}
            </>
          ) : null}
          {batch.mode} mode · concurrency {batch.concurrency} · stop-on-failure{' '}
          {batch.stop_on_failure ? 'armed' : 'off'} · started {formatDateTime(batch.started_at)}
          {batch.finished_at ? ` · finished ${formatDateTime(batch.finished_at)}` : ''}
        </p>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <MiniStat label="Settled" value={`${settled.length} / ${actions.length}`} />
          <MiniStat label="Succeeded" value={String(succeeded)} />
          <MiniStat label="Failed" value={String(failed)} error={failed > 0} />
          <MiniStat
            label="Rollbacks"
            value={String(rollbacks.length)}
            error={rollbacks.some((r) => r.status !== 'succeeded')}
          />
        </div>

        <section className="flex flex-col gap-2">
          <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-500">
            Per-action outcomes
          </h4>
          {actions.length === 0 ? (
            <p className="rounded-md bg-mist-50 p-3 text-xs text-slate-500">
              No actions are recorded against this batch yet. Actions appear here as the executor
              settles them.
            </p>
          ) : (
            <div className="overflow-x-auto rounded-md border border-slate-200">
              <table className="w-full text-left text-xs">
                <thead className="bg-mist-100 text-[10px] uppercase tracking-wider text-slate-500">
                  <tr>
                    <th scope="col" className="px-3 py-2 font-medium">
                      #
                    </th>
                    <th scope="col" className="px-3 py-2 font-medium">
                      Action
                    </th>
                    <th scope="col" className="px-3 py-2 font-medium">
                      Status
                    </th>
                    <th scope="col" className="px-3 py-2 font-medium">
                      Outcome
                    </th>
                    <th scope="col" className="px-3 py-2 font-medium">
                      Settled at
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {[...actions]
                    .sort((a, b) => a.sequence - b.sequence)
                    .map((a) => (
                      <tr key={a.id}>
                        <td className="px-3 py-2 font-mono text-slate-500">{a.sequence}</td>
                        <td className="px-3 py-2">
                          <code className="font-mono text-[11px] text-indigo-700">
                            {a.action_type}
                          </code>
                          <span className="ml-2 text-slate-500">{a.description}</span>
                        </td>
                        <td className="px-3 py-2">
                          {a.execution_status ? (
                            <StatusBadge status={a.execution_status as StatusKind} />
                          ) : (
                            <span className="text-slate-400">—</span>
                          )}
                        </td>
                        <td className="px-3 py-2">
                          {a.final_outcome ? (
                            <StatusBadge status={a.final_outcome as StatusKind} />
                          ) : (
                            <span className="text-slate-400">unsettled</span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-slate-500">
                          {a.executed_at ? formatDateTime(a.executed_at) : '—'}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <RollbackSection rollbacks={rollbacks} actionById={actionById} />
        <VerificationSection verifications={verifications} actionById={actionById} />
        {reconciliation && <ReconciliationSection reconciliation={reconciliation} />}
      </CardContent>
    </Card>
  );
}

function MiniStat({ label, value, error }: { label: string; value: string; error?: boolean }) {
  return (
    <div className="rounded-md border border-slate-200 bg-mist-50 p-3">
      <p className="text-[10px] font-medium uppercase tracking-wider text-slate-500">{label}</p>
      <p
        className={`mt-1 font-mono text-lg font-semibold ${
          error ? 'text-ember-700' : 'text-slate-800'
        }`}
      >
        {value}
      </p>
    </div>
  );
}

function RollbackSection({
  rollbacks,
  actionById,
}: {
  rollbacks: BatchRollbackRow[];
  actionById: Map<string, BatchActionRow>;
}) {
  if (rollbacks.length === 0) return null;
  return (
    <section className="flex flex-col gap-2">
      <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-500">
        Rollback state
      </h4>
      <div className="flex flex-col gap-2">
        {rollbacks.map((r) => {
          const action = actionById.get(r.action_id);
          const rollbackFailed = r.status !== 'succeeded';
          return (
            <div
              key={r.id}
              className={`rounded-md border p-3 text-xs ${
                rollbackFailed ? 'border-ember-500 bg-ember-50/40' : 'border-slate-200 bg-mist-50'
              }`}
            >
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge status={r.status === 'succeeded' ? 'approved' : 'failed'} />
                <span className="font-medium text-slate-700">
                  {ROLLBACK_TRIGGERS[r.triggered_by] ?? r.triggered_by} rollback of{' '}
                </span>
                <code className="font-mono text-[11px] text-indigo-700">
                  {action?.action_type ?? r.action_id.slice(0, 8)}
                </code>
                <span className="text-slate-500">
                  · definition {truncateHash(r.definition_hash)}
                </span>
              </div>
              <p className="mt-1 text-slate-500">
                By {r.executed_by_agent} · started {formatDateTime(r.started_at)}
                {r.finished_at ? ` · finished ${formatDateTime(r.finished_at)}` : ''}
              </p>
              {rollbackFailed && (
                <p className="mt-1 font-medium text-ember-700">
                  The undo itself did not complete. This change is applied but not reversed — it
                  must never be treated as clean.
                </p>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function VerificationSection({
  verifications,
  actionById,
}: {
  verifications: BatchVerificationRow[];
  actionById: Map<string, BatchActionRow>;
}) {
  if (verifications.length === 0) {
    return (
      <section className="flex flex-col gap-2">
        <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-500">
          Post-execution verification
        </h4>
        <p className="rounded-md bg-mist-50 p-3 text-xs text-slate-500">
          No verification was recorded for this batch. Parikshan re-runs the targeted checks per
          settled action; a halted batch skips verification entirely.
        </p>
      </section>
    );
  }
  return (
    <section className="flex flex-col gap-2">
      <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-500">
        Post-execution verification (Parikshan)
      </h4>
      <div className="flex flex-col gap-2">
        {verifications.map((v) => {
          const action = actionById.get(v.action_id);
          return (
            <div
              key={v.id}
              className={`rounded-md border p-3 text-xs ${
                v.outcome === 'passed'
                  ? 'border-slate-200 bg-mist-50'
                  : 'border-ember-500 bg-ember-50/40'
              }`}
            >
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge status={v.outcome === 'passed' ? 'approved' : 'failed'} />
                <code className="font-mono text-[11px] text-indigo-700">
                  {action?.action_type ?? v.action_id.slice(0, 8)}
                </code>
                <span className="text-slate-500">
                  {checksCount(v.checks)} check(s) re-run · {formatDateTime(v.verified_at)}
                </span>
              </div>
              {v.evidence_uri && (
                <p className="mt-1 font-mono text-[11px] text-slate-500">
                  evidence: {v.evidence_uri}
                </p>
              )}
              <details className="mt-2">
                <summary className="cursor-pointer text-[11px] font-medium text-indigo-700">
                  Check results
                </summary>
                <pre className="mt-1 overflow-x-auto rounded-md bg-slate-900 p-2 font-mono text-[11px] text-slate-100">
                  {JSON.stringify(v.checks ?? [], null, 2)}
                </pre>
              </details>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function ReconciliationSection({ reconciliation: rec }: { reconciliation: ReconciliationRow }) {
  const verdict = reconciliationVerdict(rec);
  const reality = rec.executed_reality ?? {};
  const outcomes = summarizeVerificationOutcomes(rec.verification_outcomes);
  const drift = rec.parameter_diffs.filter((d) => d.kind === 'content_digest_drift');

  return (
    <section className="flex flex-col gap-2">
      <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-500">
        Maker-checker reconciliation
      </h4>
      <div
        className={`rounded-md border p-3 text-xs ${
          verdict === 'clean' ? 'border-teal-500 bg-teal-50/40' : 'border-ember-500 bg-ember-50/40'
        }`}
      >
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={verdict === 'clean' ? 'success' : 'danger'}>
            {verdict === 'clean' ? 'Reconciled clean' : 'Needs review'}
          </Badge>
          <span className="text-slate-500">
            {outcomes.succeeded} succeeded · {outcomes.failed} failed · {outcomes.unexecuted}{' '}
            unexecuted · recorded {formatDateTime(rec.created_at)}
          </span>
        </div>

        {rec.unexecuted.length > 0 && (
          <p className="mt-2 text-ember-700">
            {rec.unexecuted.length} action(s) the batch held were never settled and were swept back
            to approved — retryable only under a fresh approval.
          </p>
        )}

        {drift.map((d, i) => (
          <p key={i} className="mt-2 font-medium text-ember-700">
            Content digest drift: the approved snapshot (
            {d.approved ? truncateHash(d.approved) : '—'}) differs from the digest recomputed over
            the stored actions ({d.recomputed ? truncateHash(d.recomputed) : '—'}). Approved content
            changed — this is stated, not hidden.
          </p>
        ))}

        <p className="mt-2 text-slate-600">{rec.statement}</p>

        <details className="mt-2">
          <summary className="cursor-pointer text-[11px] font-medium text-indigo-700">
            Reconciliation facts
          </summary>
          <div className="mt-1 flex flex-col gap-1 text-[11px] text-slate-600">
            <span>
              Batch status at finish: {reality.batch_status ?? '—'} ·{' '}
              {reality.succeeded_at_finish ?? 0} succeeded · {reality.failed_at_finish ?? 0} failed
              · {reality.rolled_back ?? 0} rolled back
            </span>
            <span className="font-mono">
              approved digest: {rec.approved_scope?.content_digest ?? '—'}
            </span>
            <span className="font-mono">
              recomputed digest: {reality.content_digest_recomputed ?? '—'}
            </span>
            <span className="font-mono">approval token: {rec.approved_scope?.token_id ?? '—'}</span>
          </div>
        </details>

        {/* The signed statement is the maker-checker attestation — the one place gold is used here. */}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <ProofSeal hash={rec.statement_signature} sealedAt={rec.created_at} />
          <span className="text-[11px] text-slate-500">
            Signature over the statement, keyed like the approval that bound the batch.
          </span>
        </div>
      </div>
    </section>
  );
}
