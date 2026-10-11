import Link from 'next/link';
import { can } from '@axiom/types';
import { ProposalPanel } from './proposal-panel';
import { OwnedTargetPanel } from './owned-target-panel';
import { DataPlaceholder, PageHeader } from '@axiom/ui';
import { requireCapabilityContext, Capability } from '@/lib/tenant-context';
import { moduleBarProps } from '@/lib/module-bar';

export const dynamic = 'force-dynamic';

export default async function PlansListPage() {
  const { supabase, tenantId, userId, role } = await requireCapabilityContext(Capability.PLAN_READ);
  const { data: plans, error } = await supabase
    .from('remediation_plans')
    .select('id, title, status, version, created_at, library_version, purpose')
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: false });

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
    <section className="w-full min-w-0 space-y-5" aria-label="Remediation plans">
      <PageHeader
        module={moduleBarProps('remediation')}
        title="Remediation plans"
        description="Plans recorded for this tenant. A plan is a proposal until its actions pass the required dry-run, rollback, and human approval gates."
      />
      <ProposalPanel
        tenantId={tenantId}
        actorId={userId}
        canPropose={can(Capability.PLAN_CREATE, { role }) && can(Capability.AGENT_INVOKE, { role })}
      />
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
