import Link from 'next/link';
import { requireCapabilityContext, Capability } from '@/lib/tenant-context';
import { ModuleBarFor } from '@/lib/module-bar';

export const dynamic = 'force-dynamic';

export default async function PlansListPage() {
  const { supabase, tenantId } = await requireCapabilityContext(Capability.PLAN_READ);
  const { data: plans, error } = await supabase
    .from('remediation_plans')
    .select('id, title, status, version, created_at, library_version')
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: false });

  return (
    <main className="mx-auto max-w-5xl space-y-5" aria-label="Remediation plans">
      <header>
        <h1 className="font-heading text-2xl font-semibold text-[#1E2A4A]">Remediation plans</h1>
        <p className="mt-2 text-sm text-slate-600">
          Plans recorded for this tenant. A plan is a proposal until its actions pass the required
          dry-run, rollback, and human approval gates.
        </p>
      </header>
      <ModuleBarFor module="remediation" />
      {error || !plans ? (
        <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-4 text-red-800">
          Plans are unavailable. No plan readiness can be inferred.
        </p>
      ) : plans.length === 0 ? (
        <p className="rounded-lg border border-slate-200 bg-white p-5 text-slate-600">
          No remediation plans recorded for this tenant.
        </p>
      ) : (
        <ul className="space-y-3">
          {plans.map((plan) => (
            <li key={plan.id} className="rounded-lg border border-slate-200 bg-white p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="font-medium text-[#1E2A4A]">{plan.title}</h2>
                  <p className="mt-1 text-xs text-slate-600">
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
    </main>
  );
}
