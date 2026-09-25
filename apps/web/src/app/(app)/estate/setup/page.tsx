import Link from 'next/link';
import { Capability, can } from '@axiom/types';
import { PageHeader } from '@axiom/ui';
import { requireCapabilityContext } from '@/lib/tenant-context';
import { SetupWizard, type WizardEstate, type WizardSystem } from './setup-wizard';
import { GrantReview, ToolRegistry } from './sustenance';

export const dynamic = 'force-dynamic';

/** C-W3-5: resumable company → estate → inventory → connection → grant review → readiness. */
export default async function EstateSetupPage() {
  const ctx = await requireCapabilityContext(Capability.POSTURE_READ);
  const [tenant, estates, systems, connectors, workloads] = await Promise.all([
    ctx.supabase
      .from('tenants')
      .select('is_sdf,processes_children_data,processes_health_data,dpo_name,dpo_email')
      .eq('id', ctx.tenantId)
      .maybeSingle(),
    ctx.supabase
      .from('estates')
      .select('id,name,status')
      .eq('tenant_id', ctx.tenantId)
      .order('created_at')
      .returns<WizardEstate[]>(),
    ctx.supabase
      .from('estate_systems')
      .select('id,estate_id,name,status,system_data_categories(category_key,source)')
      .eq('tenant_id', ctx.tenantId)
      .order('created_at'),
    ctx.supabase
      .from('connectors')
      .select('id,name,system_id,status')
      .eq('tenant_id', ctx.tenantId),
    ctx.supabase
      .from('workload_identities')
      .select('id,agent_name,spiffe_id,status')
      .eq('tenant_id', ctx.tenantId)
      .eq('status', 'active')
      .in('agent_name', ['drishti', 'karya']),
  ]);
  const failed =
    tenant.error || estates.error || systems.error || connectors.error || workloads.error;
  const registered = new Set(
    (connectors.data ?? []).filter((c) => c.status !== 'archived').map((c) => c.system_id),
  );
  const inventory: WizardSystem[] = (systems.data ?? []).map((s) => ({
    id: s.id,
    estateId: s.estate_id,
    name: s.name,
    active: s.status === 'active',
    declaredCategories: (s.system_data_categories ?? [])
      .filter((d) => d.source === 'declared')
      .map((d) => d.category_key),
    hasConnector: registered.has(s.id),
  }));
  return (
    <div className="mx-auto flex max-w-[900px] flex-col gap-6">
      <PageHeader
        title="Onboarding setup"
        description="A resumable checklist that records what you have confirmed. It does not connect systems, issue agent access or verify anything on its own."
      />
      <Link href="/estate" className="text-teal-700 underline">
        Manage estates and systems
      </Link>
      {failed ? (
        <p role="alert">Onboarding data could not be loaded. Refresh to try again.</p>
      ) : (
        <SetupWizard
          key={ctx.tenantId}
          tenantId={ctx.tenantId}
          canManage={can(Capability.ESTATE_MANAGE, { role: ctx.role })}
          profile={tenant.data ?? null}
          estates={estates.data ?? []}
          systems={inventory}
        />
      )}
      {!failed && (
        <GrantReview
          tenantId={ctx.tenantId}
          canManage={can(Capability.CONNECTOR_MANAGE, { role: ctx.role })}
          targets={{
            connectors: (connectors.data ?? [])
              .filter((c) => c.status === 'active')
              .map((c) => ({ id: c.id, name: c.name })),
            workloads: (workloads.data ?? []).map((w) => ({
              id: w.id,
              agentName: w.agent_name,
              spiffeId: w.spiffe_id,
            })),
          }}
        />
      )}
      {!failed && (
        <ToolRegistry
          tenantId={ctx.tenantId}
          canManage={can(Capability.CONNECTOR_MANAGE, { role: ctx.role })}
          connectors={(connectors.data ?? [])
            .filter((c) => c.status === 'active')
            .map((c) => ({ id: c.id, name: c.name }))}
        />
      )}
    </div>
  );
}
