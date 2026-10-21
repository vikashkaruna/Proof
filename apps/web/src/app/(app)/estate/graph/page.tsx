import Link from 'next/link';
import { AGENT_CONTRACTS, can } from '@axiom/types';
import { PageHeader } from '@axiom/ui';
import { requireCapabilityContext } from '@/lib/tenant-context';
import type { GraphInput } from '@/lib/estate-graph';
import {
  approvedGraphProposals,
  projectApprovedDerivation,
  unavailableProvenance,
} from '@/lib/estate-graph-provenance';
import { EstateGraph } from './estate-graph-client';
import { routeCapability } from '@/app/(app)/nav';
import { moduleBarProps } from '@/lib/module-bar';

export const dynamic = 'force-dynamic';

/** W3.5: the live estate as a graph, with agent access derived from enforced grants. */
export default async function EstateGraphPage() {
  const ctx = await requireCapabilityContext(routeCapability('/estate'));
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
  const failed =
    estates.error ||
    systems.error ||
    connectors.error ||
    grants.error ||
    !Array.isArray(estates.data) ||
    !Array.isArray(systems.data) ||
    !Array.isArray(connectors.data) ||
    !Array.isArray(grants.data);
  const capturedAt = new Date().toISOString();
  const input: GraphInput = {
    now: new Date(capturedAt),
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
      categoryOrigins: (s.system_data_categories ?? []).map((d) => ({
        category: d.category_key,
        source:
          d.source === 'declared'
            ? ('declared' as const)
            : d.source === 'observed'
              ? ('observed' as const)
              : ('unknown' as const),
      })),
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
  // Narrow projection only: never fetch raw intake/source snapshots, review
  // prose, actors, endpoint/configuration fields or whole ledger details.
  input.provenance = unavailableProvenance(input.systems);
  if (!failed) {
    try {
      const proposals = await ctx.supabase
        .from('onboarding_proposals')
        .select(
          'id,tenant_id,estate_id,content_sha256,status,reviewed_at,onboarding_proposal_systems(tenant_id,proposal_id,source_index,system_id)',
        )
        .eq('tenant_id', tenant)
        .eq('status', 'approved')
        .limit(2)
        .limit(101, { referencedTable: 'onboarding_proposal_systems' })
        .abortSignal(AbortSignal.timeout(5000));
      if (proposals.error) throw new Error('Source unavailable');
      const rows = approvedGraphProposals.parse(proposals.data);
      let ledger: unknown = [];
      if (rows.length) {
        const result = await ctx.supabase
          .from('audit_ledger')
          .select(
            'id,tenant_id,target_ref,actor_type,action_type,result,occurred_at,commitment:detail->>contentSha256,system_ids:detail->systemIds',
          )
          .eq('tenant_id', tenant)
          .eq('action_type', 'onboarding.proposal.approved')
          .in(
            'target_ref',
            rows.map((p) => p.id),
          )
          .limit(3)
          .abortSignal(AbortSignal.timeout(5000));
        if (result.error) throw new Error('Receipt unavailable');
        ledger = result.data;
      }
      input.provenance = projectApprovedDerivation(
        tenant,
        input.systems,
        rows,
        ledger,
        can(routeCapability('/estate'), { role: ctx.role }),
      );
    } catch {
      /* Keep existing graph available with explicit unknown provenance. */
    }
  }
  return (
    <div className="flex w-full min-w-0 flex-col gap-6">
      <PageHeader
        module={moduleBarProps('estate')}
        title="Estate graph"
        description="Estates, systems, connector registrations and data categories, with agent access drawn only from active grants in this view. Other estates or filters may have additional grants."
      />
      <Link href="/estate" className="text-teal-700 underline">
        Back to estate inventory
      </Link>
      {failed ? (
        <p role="alert">The estate graph could not be loaded. Refresh to try again.</p>
      ) : (
        <EstateGraph
          canViewInactive={ctx.isGlobalFounder === true}
          key={tenant}
          input={input}
          snapshot={{ tenantName: ctx.tenantName, capturedAt }}
        />
      )}
    </div>
  );
}
