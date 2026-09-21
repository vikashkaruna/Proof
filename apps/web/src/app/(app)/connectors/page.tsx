import { Capability, can } from '@axiom/types';
import { PageHeader } from '@axiom/ui';
import { requireCapabilityContext } from '@/lib/tenant-context';
import { ConnectorsClient, type ConnectorRow, type ConnectorSystem } from './connectors-client';
export const dynamic = 'force-dynamic';
export default async function ConnectorsPage() {
  const ctx = await requireCapabilityContext(Capability.POSTURE_READ);
  const [connectors, systems] = await Promise.all([
    ctx.supabase
      .from('connectors')
      .select(
        'id,system_id,name,endpoint_ref,descriptor_id,target_binding,assurance,status,version,connector_health_checks(status,checked_at)',
      )
      .eq('tenant_id', ctx.tenantId)
      .order('created_at')
      .order('checked_at', { referencedTable: 'connector_health_checks', ascending: false })
      .limit(1, { referencedTable: 'connector_health_checks' })
      .returns<ConnectorRow[]>(),
    ctx.supabase
      .from('estate_systems')
      .select('id,name,status,estates!inner(name,status)')
      .eq('tenant_id', ctx.tenantId)
      .order('created_at')
      .returns<ConnectorSystem[]>(),
  ]);
  return (
    <div className="mx-auto flex max-w-[1100px] flex-col gap-6">
      <PageHeader
        title="Connectors"
        description="Register access paths for estate systems. Enabling a registration does not connect to a system or grant agent access."
      />
      <p className="rounded border p-4 text-sm">
        Connector execution is not yet available. Credentials, live access grants and transport
        verification are separate steps.
      </p>
      {connectors.error || systems.error ? (
        <p role="alert">Connector inventory could not be loaded. Refresh to try again.</p>
      ) : (
        <ConnectorsClient
          key={ctx.tenantId}
          tenantId={ctx.tenantId}
          canManage={can(Capability.CONNECTOR_MANAGE, { role: ctx.role })}
          connectors={connectors.data ?? []}
          systems={systems.data ?? []}
        />
      )}
    </div>
  );
}
