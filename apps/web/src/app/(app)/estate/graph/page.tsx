import Link from 'next/link';
import { AGENT_CONTRACTS, Capability } from '@axiom/types';
import { PageHeader } from '@axiom/ui';
import { requireCapabilityContext } from '@/lib/tenant-context';
import type { GraphInput } from '@/lib/estate-graph';
import { EstateGraph } from './estate-graph-client';

export const dynamic = 'force-dynamic';

/** W3.5: the live estate as a graph, with agent access derived from enforced grants. */
export default async function EstateGraphPage() {
  const ctx = await requireCapabilityContext(Capability.POSTURE_READ);
  const tenant = ctx.tenantId;
  const [estates, systems, connectors, grants] = await Promise.all([
    ctx.supabase
      .from('estates')
      .select('id,name,status')
      .eq('tenant_id', tenant)
      .order('created_at'),
    ctx.supabase
      .from('estate_systems')
      .select('id,estate_id,name,status,system_data_categories(category_key,source)')
      .eq('tenant_id', tenant)
      .order('created_at'),
    ctx.supabase
      .from('connectors')
      .select('id,system_id,name,status,assurance')
      .eq('tenant_id', tenant)
      .order('created_at'),
    ctx.supabase
      .from('connector_grants')
      .select('id,connector_id,agent_name,internal_scope,expires_at,revoked_at')
      .eq('tenant_id', tenant)
      .is('revoked_at', null),
  ]);
  const failed = estates.error || systems.error || connectors.error || grants.error;
  const input: GraphInput = {
    agents: Object.values(AGENT_CONTRACTS).map((a) => ({
      name: a.name,
      displayName: a.displayName,
    })),
    estates: estates.data ?? [],
    systems: (systems.data ?? []).map((s) => ({
      id: s.id,
      estateId: s.estate_id,
      name: s.name,
      status: s.status,
      categories: [...new Set((s.system_data_categories ?? []).map((d) => d.category_key))].sort(),
    })),
    connectors: (connectors.data ?? []).map((c) => ({
      id: c.id,
      systemId: c.system_id,
      name: c.name,
      status: c.status,
      assurance: c.assurance,
    })),
    grants: (grants.data ?? []).map((g) => ({
      id: g.id,
      connectorId: g.connector_id,
      agentName: g.agent_name,
      // The table check constraint admits only these two scopes.
      scope: g.internal_scope as 'connector.read' | 'connector.write',
      expiresAt: g.expires_at,
      revokedAt: g.revoked_at,
    })),
  };
  return (
    <div className="mx-auto flex max-w-[1200px] flex-col gap-6">
      <PageHeader
        title="Estate graph"
        description="Estates, systems, connector registrations and data categories, with agent access drawn only from active grants. No edge means no access."
      />
      <Link href="/estate" className="text-teal-700 underline">
        Back to estate inventory
      </Link>
      {failed ? (
        <p role="alert">The estate graph could not be loaded. Refresh to try again.</p>
      ) : (
        <EstateGraph input={input} />
      )}
    </div>
  );
}
