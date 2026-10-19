import Link from 'next/link';
import {
  PlanDecisionSummarySchema,
  can,
  summariseDryRuns,
  summariseRollbacks,
  type PlanDecisionSummary,
  type SummaryTone,
} from '@axiom/types';
import { ProposalPanel } from './proposal-panel';
import { OwnedTargetPanel } from './owned-target-panel';
import { DataPlaceholder, PageHeader, formatDateTime } from '@axiom/ui';
import { requireCapabilityContext, Capability } from '@/lib/tenant-context';
import { moduleBarProps } from '@/lib/module-bar';
import { ownedDeploymentAccess } from '@/lib/owned-deployment-access';
import { routeCapability } from '@/app/(app)/nav';

export const dynamic = 'force-dynamic';

export default async function PlansListPage() {
  const { supabase, tenantId, userId, role, isAxiomInternal } = await requireCapabilityContext(
    routeCapability('/plans'),
  );
  const { data: plans, error } = await supabase
    .from('remediation_plans')
    .select('id, title, status, version, created_at, library_version, purpose')
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: false });

  // Per-plan approval, dry-run and rollback state from the RECORDED runs and the
  // decision records (migration 0157), read under RLS. If it cannot be read the
  // list says so rather than inferring readiness from plan status.
  const summariesRes = await supabase.rpc('plan_decision_summaries', { p_tenant_id: tenantId });
  const summariesParsed = summariesRes.error
    ? null
    : PlanDecisionSummarySchema.array().safeParse(summariesRes.data);
  const summaries = summariesParsed?.success
    ? new Map(summariesParsed.data.map((row) => [row.plan_id, row]))
    : null;

  const ownedEnabled =
    process.env.AXIOM_OWNED_SYNTHETIC_ENABLED === 'true' &&
    ['local', 'test'].includes(process.env.ENVIRONMENT ?? '') &&
    (process.env.AXIOM_AUTH_MODE ?? 'strict') === 'strict';
  const canCreateOwned =
    can(Capability.PLAN_CREATE, { role }) && can(Capability.PLAN_EXECUTE, { role });
  const ownedEngagements =
    ownedEnabled && canCreateOwned
      ? await supabase
          .from('engagements')
          .select('id, title')
          .eq('tenant_id', tenantId)
          .neq('status', 'cancelled')
          .order('created_at', { ascending: false })
          .limit(20)
      : null;

  return (
    <section className="w-full min-w-0 space-y-4" aria-label="Remediation plans">
      <PageHeader
        module={moduleBarProps('remediation')}
        title="Remediation Plans"
        description="Plans recorded for this tenant. A plan is a proposal until its actions pass the required dry-run, rollback, and human approval gates."
      />
      <ProposalPanel
        tenantId={tenantId}
        actorId={userId}
        canPropose={can(Capability.PLAN_CREATE, { role }) && can(Capability.AGENT_INVOKE, { role })}
      />
      {ownedDeploymentAccess(role, isAxiomInternal).available && (
        <p className="rounded-lg border border-slate-200 bg-white p-4 text-sm">
          Need a synthetic target first?{' '}
          <Link className="font-semibold text-teal-800 underline" href="/settings/owned-targets">
            Prepare and verify demo execution setup
          </Link>{' '}
          before creating its separately approved remediation plan.
        </p>
      )}
      {ownedEnabled && (
        <>
          {ownedEngagements?.error && (
            <p role="alert" className="text-sm text-red-800">
              Owned target engagements are unavailable. Retained requests can still be checked
              against their original source.
            </p>
          )}
          <OwnedTargetPanel
            tenantId={tenantId}
            actorId={userId}
            canCreate={canCreateOwned}
            engagements={ownedEngagements?.data ?? []}
          />
        </>
      )}
      {error || !plans ? (
        <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-4 text-red-800">
          Plans are unavailable. No plan readiness can be inferred.
        </p>
      ) : plans.length === 0 ? (
        <DataPlaceholder title="No remediation plans recorded for this tenant." />
      ) : (
        <ul className="space-y-3">
          {plans.map((plan) => (
            <li key={plan.id} className="rounded-lg border border-slate-200 bg-white p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="font-medium text-[#1E2A4A]">{plan.title}</h2>
                  <p className="mt-1 text-xs text-slate-600">
                    {plan.purpose === 'source_review'
                      ? 'Review-only work · 0 corrective actions · '
                      : ''}
                    Status {plan.status} · Version {plan.version} · Library{' '}
                    {plan.library_version ?? 'not recorded'}
                  </p>
                  {plan.purpose !== 'source_review' && (
                    <PlanStatusGrid
                      status={plan.status}
                      summary={summaries?.get(plan.id) ?? null}
                    />
                  )}
                </div>
                <Link
                  href={`/plans/${plan.id}`}
                  className="rounded-md border border-slate-300 px-3 py-2 text-sm font-medium text-[#1E2A4A] focus-visible:outline-2 focus-visible:outline-teal-500"
                >
                  Inspect plan
                </Link>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const TONE_CLASS: Record<SummaryTone, string> = {
  ok: 'text-teal-800',
  warn: 'text-amber-800',
  bad: 'text-ember-700',
  none: 'text-slate-500',
};

/** Approval, dry-run and rollback state plus decision times, for one plan row. */
function PlanStatusGrid({
  status,
  summary,
}: {
  status: string;
  summary: PlanDecisionSummary | null;
}) {
  if (!summary) {
    return (
      <p className="mt-2 text-xs text-ember-700">
        Approval, dry-run and rollback status are unavailable for this plan.
      </p>
    );
  }
  const dryRuns = summariseDryRuns(summary);
  const rollbacks = summariseRollbacks(summary);
  const approval = `${status.replace(/_/g, ' ')} · ${summary.approved_actions}/${summary.action_count} actions approved`;
  return (
    <dl
      aria-label="Plan approval status"
      className="mt-2 grid grid-cols-1 gap-x-6 gap-y-1 text-xs sm:grid-cols-2 lg:grid-cols-5"
    >
      <Cell term="Approval" value={approval} tone={status === 'approved' ? 'ok' : 'none'} />
      <Cell term="Dry runs (recorded)" value={dryRuns.label} tone={dryRuns.tone} />
      <Cell term="Rollback" value={rollbacks.label} tone={rollbacks.tone} />
      <Cell
        term="Approved at"
        value={summary.last_approved_at ? formatDateTime(summary.last_approved_at) : '—'}
        tone="none"
      />
      <Cell
        term="Rejected at"
        value={summary.last_rejected_at ? formatDateTime(summary.last_rejected_at) : '—'}
        tone="none"
      />
    </dl>
  );
}

function Cell({ term, value, tone }: { term: string; value: string; tone: SummaryTone }) {
  return (
    <div>
      <dt className="text-[10px] font-medium uppercase tracking-wider text-slate-500">{term}</dt>
      <dd className={TONE_CLASS[tone]}>{value}</dd>
    </div>
  );
}
