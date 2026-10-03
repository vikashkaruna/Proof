import { GenericModuleView, type ModuleTelemetryEvent } from '../generic-module-view';
import { requireTenantContext } from '@/lib/tenant-context';

export const dynamic = 'force-dynamic';

export default async function ClassificationPage() {
  const { supabase, tenantId } = await requireTenantContext();
  const { data, error } = await supabase
    .from('audit_ledger')
    .select('sequence_no, correlation_id, action_type, target_ref, occurred_at, entry_hash, result')
    .eq('tenant_id', tenantId)
    .eq('actor_id', 'vibhaag')
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
        moduleKey: 'classification',
        title: 'Data Classification',
        hi: 'वर्गीकरण',
        phase: 'P1',
        agent: 'Vibhaag',
        agentKey: 'vibhaag',
        autonomy: 'L1',
        moduleId: 'M2.3',
        desc: 'Run classification against a connected estate. Recorded activity appears below; field counts and categories require an actual assessment source.',
        actionLabel: 'Run Classification Scan',
        cards: [],
        recentEvents: events,
        telemetryTitle: 'Recorded Classification Events',
      }}
    >
      {error || !data ? (
        <p role="alert">Classification ledger records are unavailable.</p>
      ) : events.length === 0 ? (
        <p>No classification events recorded for this tenant.</p>
      ) : null}
    </GenericModuleView>
  );
}
