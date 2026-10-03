import Link from 'next/link';
import { DataPlaceholder } from '@axiom/ui';
import { ModuleBarFor } from '@/lib/module-bar';
import { requireCapabilityContext, Capability } from '@/lib/tenant-context';

export const dynamic = 'force-dynamic';

export default async function ApprovalPage() {
  const { supabase, tenantId } = await requireCapabilityContext(Capability.PLAN_READ);
  const { data: actions, error } = await supabase
    .from('remediation_actions')
    .select('id, plan_id, description, action_type, approval_status, risk_class')
    .eq('tenant_id', tenantId)
    .eq('approval_status', 'awaiting_approval')
    .order('sequence', { ascending: true });

  return (
    <main className="mx-auto max-w-5xl space-y-5" aria-label="Approval queue">
      <header>
        <h1 className="font-heading text-2xl font-semibold text-[#1E2A4A]">Approval queue</h1>
        <p className="mt-2 text-sm text-slate-600">
          Recorded actions awaiting human review. Open the source plan to inspect the dry-run,
          rollback, scope, and approval authority before taking action.
        </p>
        <ModuleBarFor module="approval" className="mt-3" />
      </header>
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
    </main>
  );
}
