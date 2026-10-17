import Link from 'next/link';
import { notFound } from 'next/navigation';
import { PlanReadinessSchema, type ActionReadiness } from '@axiom/types';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  PageHeader,
  SeverityChip,
  formatDateTime,
} from '@axiom/ui';
import { requireCapabilityContext, Capability } from '@/lib/tenant-context';
import { moduleBarProps } from '@/lib/module-bar';
import { describeRefusal, parseDryRunChanges } from '@/lib/execution-view';
import {
  blockerReasons,
  cacheContradictsRecord,
  dryRunBadge,
  recordedDryRunState,
} from '@/lib/dry-run-truth';
import { DryRunDiffView } from '../../../../execution/dry-run-diff';
import type { DryRunRow } from '../../dry-run-history';

export const dynamic = 'force-dynamic';

interface PageProps {
  params: Promise<{ id: string; actionId: string }>;
}

interface ActionRow {
  id: string;
  plan_id: string;
  sequence: number;
  action_type: string;
  description: string;
  risk_class: 'low' | 'medium' | 'high' | 'critical';
  parameters: unknown;
  dry_run_status: string;
  latest_dry_run_id: string | null;
  rollback_definition: Record<string, unknown> | null;
  rollback_validated: boolean;
  rollback_validated_at: string | null;
  approval_status: string;
  approved_at: string | null;
}

interface RollbackExecutionRow {
  id: string;
  status: 'succeeded' | 'failed' | 'partial';
  triggered_by: string;
  definition_hash: string;
  executed_by_agent: string;
  started_at: string;
  finished_at: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Read-only detail of one action's recorded dry run and its rollback — what an
 * approver needs to see before deciding, and what an auditor checks after.
 * Every value shown is a stored record read under RLS; nothing is recomputed
 * here except presentation. Times are in the deployment display zone (IST).
 */
export default async function ActionDryRunRollbackPage({ params }: PageProps) {
  const { id: planId, actionId } = await params;
  if (!UUID.test(planId) || !UUID.test(actionId)) notFound();
  const { supabase, tenantId } = await requireCapabilityContext(Capability.PLAN_READ);

  const [planRes, actionRes] = await Promise.all([
    supabase
      .from('remediation_plans')
      .select('id, title, status')
      .eq('id', planId)
      .eq('tenant_id', tenantId)
      .maybeSingle(),
    supabase
      .from('remediation_actions')
      .select(
        `id, plan_id, sequence, action_type, description, risk_class, parameters,
         dry_run_status, latest_dry_run_id, rollback_definition, rollback_validated,
         rollback_validated_at, approval_status, approved_at`,
      )
      .eq('id', actionId)
      .eq('plan_id', planId)
      .eq('tenant_id', tenantId)
      .maybeSingle(),
  ]);
  const plan = planRes.data as { id: string; title: string; status: string } | null;
  const action = actionRes.data as ActionRow | null;
  if (!plan || !action) notFound();

  const [runsRes, rollbacksRes, readinessRes] = await Promise.all([
    supabase
      .from('dry_runs')
      .select(
        `id, action_id, status, diff, refusal_reason, renderable, parameters_hash,
         rollback_definition_hash, simulated_by, correlation_id, expires_at, created_at`,
      )
      .eq('action_id', actionId)
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: false })
      .limit(50),
    supabase
      .from('rollback_executions')
      .select(
        'id, status, triggered_by, definition_hash, executed_by_agent, started_at, finished_at',
      )
      .eq('action_id', actionId)
      .eq('tenant_id', tenantId)
      .order('started_at', { ascending: false })
      .limit(20),
    supabase.rpc('plan_approval_readiness', { p_tenant_id: tenantId, p_plan_id: planId }),
  ]);
  const runs = (runsRes.data ?? []) as unknown as DryRunRow[];
  const rollbacks = (rollbacksRes.data ?? []) as unknown as RollbackExecutionRow[];
  const parsed = readinessRes.error ? null : PlanReadinessSchema.safeParse(readinessRes.data);
  const readiness: ActionReadiness | null =
    (parsed?.success ? parsed.data.actions.find((a) => a.actionId === actionId) : null) ?? null;

  const current = runs.find((r) => r.id === action.latest_dry_run_id) ?? null;
  const earlier = runs.filter((r) => r.id !== current?.id);
  const state = recordedDryRunState(readiness);
  const badge = dryRunBadge(state);
  const reasons = blockerReasons(readiness);
  const rollback = action.rollback_definition ?? null;
  const steps = Array.isArray(rollback?.['steps']) ? (rollback['steps'] as unknown[]) : null;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        module={moduleBarProps('remediation')}
        title={`Action #${action.sequence} · ${action.action_type}`}
        description={action.description}
        actions={
          <Button variant="outline" size="sm" asChild>
            <Link href={`/plans/${planId}`}>← Back to plan</Link>
          </Button>
        }
        meta={
          <>
            <Badge variant="neutral">Plan: {plan.title}</Badge>
            <SeverityChip severity={action.risk_class} />
            <Badge variant="indigo">Approval: {action.approval_status.replace(/_/g, ' ')}</Badge>
          </>
        }
      />

      <Card>
        <CardHeader>
          <CardTitle>Approval readiness (BR-2)</CardTitle>
          <CardDescription>
            Approval needs a recorded, unexpired, successful dry run for the action&apos;s current
            content, and a validated rollback. This is the same check the server applies.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {readiness?.ready ? (
            <p className="text-sm text-teal-800">
              <Badge variant="success">Ready</Badge> Every requirement is met.
            </p>
          ) : (
            <ul
              aria-label="Missing requirements"
              className="list-disc space-y-1 pl-5 text-sm text-ember-700"
            >
              {reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Recorded dry run</CardTitle>
          <CardDescription>
            The run this action links to — the one an approval would rely on. The action&apos;s
            status field (&ldquo;{action.dry_run_status.replace(/_/g, ' ')}&rdquo;) is a display
            cache, not a record.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <p>
            <Badge variant={badge.variant}>{badge.label}</Badge>
          </p>
          {cacheContradictsRecord(action.dry_run_status, readiness) && (
            <p role="alert" className="text-sm text-ember-700">
              The status field says the dry run is complete, but no dry run is recorded for this
              action. Nothing below can be shown because there is nothing on record.
            </p>
          )}
          {current ? (
            <>
              <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
                <Fact term="Outcome" value={current.status} />
                <Fact term="Simulated by" value={current.simulated_by} />
                <Fact term="Recorded" value={formatDateTime(current.created_at)} />
                <Fact term="Approval window ends" value={formatDateTime(current.expires_at)} />
                <Fact term="Parameters hash" value={current.parameters_hash} mono />
                <Fact
                  term="Rollback definition hash"
                  value={current.rollback_definition_hash}
                  mono
                />
                <Fact term="Correlation id" value={current.correlation_id} mono />
                <Fact term="Dry-run id" value={current.id} mono />
              </dl>
              {current.status === 'succeeded' ? (
                <RunDiff diff={current.diff} />
              ) : (
                <p className="text-sm text-ember-700">{describeRefusal(current.refusal_reason)}</p>
              )}
            </>
          ) : (
            !cacheContradictsRecord(action.dry_run_status, readiness) && (
              <p className="text-sm text-slate-600">No dry run is recorded for this action yet.</p>
            )
          )}
          <details className="rounded-md border border-slate-200 bg-mist-50 p-3">
            <summary className="cursor-pointer text-sm font-medium text-indigo-700">
              Stored parameters the run is bound to
            </summary>
            <pre className="mt-2 overflow-x-auto rounded-md bg-slate-900 p-3 font-mono text-xs text-slate-100">
              {JSON.stringify(action.parameters ?? null, null, 2)}
            </pre>
          </details>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Rollback</CardTitle>
          <CardDescription>
            The stored rollback definition. Its hash at simulation time is shown above with the run.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
            <Fact
              term="Validation"
              value={action.rollback_validated ? 'Validated' : 'Not validated'}
            />
            <Fact
              term="Validated at"
              value={
                action.rollback_validated_at ? formatDateTime(action.rollback_validated_at) : '—'
              }
            />
            <Fact
              term="Strategy"
              value={
                typeof rollback?.['strategy'] === 'string' ? (rollback['strategy'] as string) : '—'
              }
            />
            <Fact
              term="Estimated rollback time"
              value={
                typeof rollback?.['estimatedRollbackTimeSeconds'] === 'number'
                  ? `~${rollback['estimatedRollbackTimeSeconds'] as number}s`
                  : '—'
              }
            />
          </dl>
          {steps && steps.length > 0 && (
            <ol
              aria-label="Rollback steps"
              className="list-decimal space-y-1 pl-5 text-sm text-slate-700"
            >
              {steps.map((step, i) => (
                <li key={i}>
                  <code className="font-mono text-xs">{JSON.stringify(step)}</code>
                </li>
              ))}
            </ol>
          )}
          <pre className="overflow-x-auto rounded-md bg-slate-900 p-3 font-mono text-xs text-slate-100">
            {JSON.stringify(rollback, null, 2)}
          </pre>
          {rollbacks.length > 0 && (
            <div>
              <p className="text-sm font-medium text-slate-800">Rollback executions</p>
              <ul className="mt-1 space-y-1 text-xs text-slate-600">
                {rollbacks.map((r) => (
                  <li key={r.id}>
                    <Badge variant={r.status === 'succeeded' ? 'success' : 'danger'}>
                      {r.status}
                    </Badge>{' '}
                    {r.triggered_by} by {r.executed_by_agent} · started{' '}
                    {formatDateTime(r.started_at)}
                    {r.finished_at ? ` · finished ${formatDateTime(r.finished_at)}` : ''}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </CardContent>
      </Card>

      {earlier.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Earlier recorded runs</CardTitle>
            <CardDescription>
              Append-only history, newest first. A later refusal invalidates an earlier success.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="space-y-2 text-xs text-slate-600">
              {earlier.map((run) => (
                <li key={run.id} className="rounded-md border border-slate-200 p-2">
                  <Badge variant={run.status === 'succeeded' ? 'success' : 'warning'}>
                    {run.status}
                  </Badge>{' '}
                  by {run.simulated_by} · {formatDateTime(run.created_at)} · window ends{' '}
                  {formatDateTime(run.expires_at)}
                  {run.status !== 'succeeded' && ` · ${describeRefusal(run.refusal_reason)}`}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function Fact({ term, value, mono = false }: { term: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] font-medium uppercase tracking-wider text-slate-500">{term}</dt>
      <dd className={mono ? 'break-all font-mono text-xs text-slate-700' : 'text-slate-800'}>
        {value}
      </dd>
    </div>
  );
}

function RunDiff({ diff }: { diff: unknown }) {
  const changes = parseDryRunChanges(diff);
  return changes ? (
    <DryRunDiffView changes={changes} />
  ) : (
    <pre className="overflow-x-auto rounded-md bg-slate-900 p-3 font-mono text-xs text-slate-100">
      {JSON.stringify(diff ?? null, null, 2)}
    </pre>
  );
}
