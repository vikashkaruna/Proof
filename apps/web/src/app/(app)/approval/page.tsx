import Link from 'next/link';
import { DataPlaceholder, PageHeader } from '@axiom/ui';
import { moduleBarProps } from '@/lib/module-bar';
import { redirect } from 'next/navigation';
import { authorize } from '@axiom/types';
import { requireTenantContext, Capability } from '@/lib/tenant-context';

export const dynamic = 'force-dynamic';

export default async function ApprovalPage() {
  // Admission is by ROLE: a scoped approver may open the queue. Scope is then
  // decided per action (its action_type is the action class, as the BFF
  // approve route uses), so out-of-scope actions are shown but not offered.
  const { supabase, tenantId, role, approvalScopes } = await requireTenantContext();
  if (!authorize(Capability.PLAN_APPROVE, { role }).allowed) redirect('/portal?error=forbidden');
  const scoped = (approvalScopes ?? []).length > 0;
  const inScope = (actionClass: string | null) =>
    authorize(Capability.PLAN_APPROVE, {
      role,
      approvalScopes,
      actionClass: actionClass ?? undefined,
    }).allowed;
  const { data: actions, error } = await supabase
    .from('remediation_actions')
    .select('id, plan_id, description, action_type, approval_status, risk_class')
    .eq('tenant_id', tenantId)
    .eq('approval_status', 'awaiting_approval')
    .order('sequence', { ascending: true });

  return (
    <section className="w-full min-w-0 space-y-4" aria-label="Approval queue">
      <PageHeader
        module={moduleBarProps('approval')}
        title="Approval Queue"
        description="Recorded actions awaiting human review. Open the source plan to inspect the dry-run, rollback, scope, and approval authority before taking action."
      />
      {error || !actions ? (
        <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-4 text-red-800">
          Approval actions are unavailable. No approval status can be inferred.
        </p>
      ) : actions.length === 0 ? (
        <DataPlaceholder title="No recorded actions await approval." />
      ) : (
        <ul className="space-y-3">
          {actions.map((action) => (
            <li key={action.id} className="rounded-lg border border-slate-200 bg-white p-4">
              <h2 className="font-medium text-[#1E2A4A]">
                {action.description || action.action_type || action.id}
              </h2>
              <p className="mt-1 break-all text-xs text-slate-600">
                Action {action.id} · Recorded risk {action.risk_class ?? 'unavailable'}
              </p>
              {scoped && (
                <p
                  className={
                    inScope(action.action_type)
                      ? 'mt-2 inline-block rounded bg-teal-50 px-2 py-0.5 text-xs font-medium text-teal-800'
                      : 'mt-2 inline-block rounded bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600'
                  }
                >
                  {inScope(action.action_type)
                    ? `Within your approval scope (${action.action_type})`
                    : `Outside your approval scope (${action.action_type ?? 'unclassified'}) — view only`}
                </p>
              )}
              <Link
                href={`/plans/${action.plan_id}`}
                className="mt-3 inline-block rounded-md bg-[#1E2A4A] px-3 py-2 text-sm font-medium text-white focus-visible:outline-2 focus-visible:outline-teal-500"
              >
                Inspect source plan
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
