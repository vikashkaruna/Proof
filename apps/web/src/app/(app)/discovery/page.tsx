import { GenericModuleView, type ModuleTelemetryEvent } from '../generic-module-view';
import { requireCapabilityContext, Capability } from '@/lib/tenant-context';
import { can } from '@axiom/types';
import { DataPlaceholder } from '@axiom/ui';

export const dynamic = 'force-dynamic';

export default async function DiscoveryPage() {
  const { supabase, tenantId, role } = await requireCapabilityContext(Capability.POSTURE_READ);
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
      <section
        aria-label="Prepare discovery"
        className="rounded-xl bg-white p-4 text-sm text-slate-600"
      >
        <p>
          Drishti needs a selected engagement and source inventory or interview answers. An
          interactive discovery run form is not yet available.
        </p>
        <p className="mt-2">
          {can(Capability.ESTATE_MANAGE, { role })
            ? 'Review estate setup to record the systems you have confirmed. Setup does not start a discovery scan.'
            : 'Ask an estate manager to prepare the source inventory for review.'}
        </p>
      </section>
      {error || !data ? (
        <p role="alert">Discovery ledger records are unavailable.</p>
      ) : events.length === 0 ? (
        <DataPlaceholder title="No discovery events recorded for this tenant." />
      ) : null}
    </GenericModuleView>
  );
}
