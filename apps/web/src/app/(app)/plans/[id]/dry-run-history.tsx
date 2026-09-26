import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  StatusBadge,
  type StatusKind,
} from '@axiom/ui';
import { formatDateTime, relativeTime, truncateHash } from '@axiom/ui';
import { describeRefusal, parseDryRunChanges } from '@/lib/execution-view';
import { DryRunDiffView } from '../../execution/dry-run-diff';

/** A row of `dry_runs` (migration 0060) as the plan read returns it. */
export interface DryRunRow {
  id: string;
  action_id: string;
  status: 'succeeded' | 'refused' | 'failed';
  diff: unknown;
  refusal_reason: string | null;
  renderable: boolean;
  parameters_hash: string;
  rollback_definition_hash: string;
  simulated_by: string;
  correlation_id: string;
  expires_at: string;
  created_at: string;
}

const RUN_STATUS_KIND: Record<DryRunRow['status'], StatusKind> = {
  succeeded: 'approved',
  refused: 'awaiting',
  failed: 'failed',
};

/**
 * The recorded dry-run history for a plan, newest first — including the
 * refusals, which are outcomes an auditor looks for rather than noise.
 * Append-only: a refusal invalidates any earlier success, so the trail shows
 * exactly why an action lost its eligibility.
 */
export function DryRunHistory({
  runs,
  actionLabels,
}: {
  runs: DryRunRow[];
  actionLabels: Map<string, string>;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Recorded dry runs</CardTitle>
        <p className="text-xs text-slate-500">
          Every simulation Sudhaar ran against this plan&apos;s stored action content, newest first.
          A run is bound to the exact parameters it simulated — the hashes below are computed over
          the stored rows, server-side — and a success opens a 24-hour approval window. Refusals are
          recorded outcomes, not errors.
        </p>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {runs.length === 0 ? (
          <div className="rounded-lg border border-dashed border-slate-300 bg-mist-50 p-6 text-center">
            <p className="text-sm font-medium text-indigo-500">No dry runs recorded yet</p>
            <p className="mx-auto mt-1 max-w-md text-xs leading-relaxed text-slate-500">
              A dry run is recorded when the plan is simulated from the plan detail or the agent
              runtime. Until one succeeds and its rollback validates, no action here can be approved
              or executed — that is BR-2, not a bug.
            </p>
          </div>
        ) : (
          runs.map((run) => {
            const changes = run.status === 'succeeded' ? parseDryRunChanges(run.diff) : null;
            const actionLabel = actionLabels.get(run.action_id) ?? `${run.action_id.slice(0, 8)}…`;
            return (
              <div key={run.id} className="rounded-md border border-slate-200 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <StatusBadge status={RUN_STATUS_KIND[run.status]} />
                  <code className="font-mono text-[11px] text-indigo-700">{actionLabel}</code>
                  {run.status !== 'succeeded' && (
                    <Badge variant="warning">{run.refusal_reason ?? run.status}</Badge>
                  )}
                  <span className="text-[11px] text-slate-500">
                    by {run.simulated_by} · {formatDateTime(run.created_at)} · window ends{' '}
                    {formatDateTime(run.expires_at)} ({relativeTime(run.expires_at)})
                  </span>
                </div>

                {run.status === 'succeeded' ? (
                  changes ? (
                    <div className="mt-2">
                      <DryRunDiffView changes={changes} />
                    </div>
                  ) : (
                    <details className="mt-2">
                      <summary className="cursor-pointer text-[11px] font-medium text-indigo-700">
                        Stored diff (raw)
                      </summary>
                      <pre className="mt-1 overflow-x-auto rounded-md bg-slate-900 p-2 font-mono text-[11px] text-slate-100">
                        {JSON.stringify(run.diff ?? { note: 'no diff captured' }, null, 2)}
                      </pre>
                    </details>
                  )
                ) : (
                  <p className="mt-2 text-xs text-ember-700">
                    {describeRefusal(run.refusal_reason)}
                  </p>
                )}

                <p className="mt-2 font-mono text-[10px] text-slate-400">
                  params {truncateHash(run.parameters_hash, 6)} · rollback{' '}
                  {truncateHash(run.rollback_definition_hash, 6)} · corr{' '}
                  {run.correlation_id.slice(0, 8)}…
                </p>
              </div>
            );
          })
        )}
      </CardContent>
    </Card>
  );
}
