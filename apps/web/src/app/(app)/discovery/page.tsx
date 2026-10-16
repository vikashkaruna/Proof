import { GenericModuleView, type ModuleTelemetryEvent } from '../generic-module-view';
import { requireCapabilityContext, Capability } from '@/lib/tenant-context';
import { can, UserRole } from '@axiom/types';
import { PublicSourceWorkflow } from '../public-source-workflow/source-workflow';
import { DataPlaceholder } from '@axiom/ui';
import { routeCapability } from '@/app/(app)/nav';
import { z } from 'zod';

export const dynamic = 'force-dynamic';

export default async function DiscoveryPage({
  searchParams,
}: {
  searchParams?: Promise<{ checkId?: string | string[] }>;
} = {}) {
  const requestedCheck = (await searchParams)?.checkId;
  const selectedCheck = z.uuid().safeParse(requestedCheck);
  const { supabase, tenantId, userId, role, isAxiomInternal } = await requireCapabilityContext(
    routeCapability('/discovery'),
  );
  const { data, error } = await supabase
    .from('audit_ledger')
    .select('sequence_no, correlation_id, action_type, target_ref, occurred_at, entry_hash, result')
    .eq('tenant_id', tenantId)
    .eq('actor_id', 'drishti')
    .order('sequence_no', { ascending: false })
    .limit(6);
  const events: ModuleTelemetryEvent[] =
    error || !data
      ? []
      : data.map((row) => ({
          seq: row.sequence_no,
          title: row.action_type,
          detail: row.correlation_id
            ? `Correlation: ${row.correlation_id}`
            : 'No correlation ID recorded',
          time: row.occurred_at || 'Time unavailable',
          target: row.target_ref || undefined,
          hash: row.entry_hash || undefined,
          status: row.result || 'Result unavailable',
        }));
  return (
    <GenericModuleView
      meta={{
        moduleKey: 'discovery',
        title: 'Data Discovery',
        hi: 'डेटा खोज',
        phase: 'P1',
        agent: 'Drishti',
        agentKey: 'drishti',
        autonomy: 'L1',
        moduleId: 'M2.2',
        desc: 'Review recorded discovery activity. Inventory size, residency, and storage assurance require observed source data.',
        actionLabel: 'Review estate setup',
        actionHref: can(Capability.ESTATE_MANAGE, { role }) ? '/estate/setup' : undefined,
        cards: [],
        recentEvents: events,
        telemetryTitle: 'Recorded Discovery Events',
      }}
    >
      {requestedCheck !== undefined && !selectedCheck.success && (
        <p role="alert">The saved website check link is invalid. Choose a saved check below.</p>
      )}
      <PublicSourceWorkflow
        initialCheckId={selectedCheck.success ? selectedCheck.data.toLowerCase() : undefined}
        tenantId={tenantId}
        actorId={userId}
        canCapture={
          can(Capability.CONNECTOR_MANAGE, { role }) &&
          (role !== UserRole.FOUNDER || isAxiomInternal)
        }
        canReview={
          can(Capability.ASSESSMENT_RUN, { role }) &&
          ((role !== UserRole.FOUNDER && role !== UserRole.AXIOM_ANALYST) || isAxiomInternal)
        }
        canInvoke={
          can(Capability.AGENT_INVOKE, { role }) &&
          ((role !== UserRole.FOUNDER && role !== UserRole.AXIOM_ANALYST) || isAxiomInternal)
        }
      />
      {error || !data ? (
        <p role="alert">Discovery ledger records are unavailable.</p>
      ) : events.length === 0 ? (
        <DataPlaceholder title="No discovery events recorded for this tenant." />
      ) : null}
    </GenericModuleView>
  );
}
