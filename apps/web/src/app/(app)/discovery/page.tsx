import { GenericModuleView, type ModuleTelemetryEvent } from '../generic-module-view';
import { requireTenantContext } from '@/lib/tenant-context';

export const dynamic = 'force-dynamic';

export default async function DiscoveryPage() {
  const { supabase, tenantId } = await requireTenantContext();
  const { data, error } = await supabase.from('audit_ledger')
    .select('sequence_no, correlation_id, action_type, target_ref, occurred_at, entry_hash, result')
    .eq('tenant_id', tenantId).eq('actor_id', 'drishti')
    .order('sequence_no', { ascending: false }).limit(6);
  const events: ModuleTelemetryEvent[] = error || !data ? [] : data.map((row) => ({
    seq: row.sequence_no,
    title: row.action_type,
    detail: row.correlation_id ? `Correlation: ${row.correlation_id}` : 'No correlation ID recorded',
    time: row.occurred_at || 'Time unavailable',
    target: row.target_ref || undefined,
    hash: row.entry_hash || undefined,
    status: row.result || 'Result unavailable',
  }));
  return (
    <GenericModuleView meta={{
      title: 'Data Discovery', hi: 'डेटा खोज', phase: 'P1', agent: 'Drishti',
      agentKey: 'drishti', autonomy: 'L1', moduleId: 'M2.2',
      desc: 'Run discovery against a registered estate. Recorded activity appears below; inventory size, residency, and storage assurance require observed source data.',
      actionLabel: 'Run Discovery Scan', cards: [], recentEvents: events,
      telemetryTitle: 'Recorded Discovery Events',
    }}>
      {error || !data ? <p role="alert">Discovery ledger records are unavailable.</p>
        : events.length === 0 ? <p>No discovery events recorded for this tenant.</p> : null}
    </GenericModuleView>
  );
}
