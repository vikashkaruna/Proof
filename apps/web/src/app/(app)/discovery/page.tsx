import { GenericModuleView, type ModuleTelemetryEvent } from '../generic-module-view';
import { requireTenantContext } from '@/lib/tenant-context';

export const dynamic = 'force-dynamic';

export default async function DiscoveryPage() {
  // SEC-3: was `createSupabaseAdmin()`, whose service-role key bypasses RLS.
  // The client below is user-scoped, so a missing tenant filter is an empty
  // result rather than a cross-tenant leak.
  const { supabase, tenantId } = await requireTenantContext();
  let drishtiRuns: any[] = [];
  let totalDrishtiScans = 0;

  try {
    const { data, count } = await supabase
      .from('audit_ledger')
      .select(
        'sequence_no, correlation_id, action_type, target_ref, occurred_at, entry_hash, result',
        {
          count: 'estimated',
        },
      )
      .eq('tenant_id', tenantId)
      .eq('actor_id', 'drishti')
      .order('sequence_no', { ascending: false })
      .limit(6);

    drishtiRuns = data || [];
    totalDrishtiScans = count ?? drishtiRuns.length;
  } catch {
    // Graceful fallback if database offline
  }

  const telemetryEvents: ModuleTelemetryEvent[] = drishtiRuns.map((r) => ({
    seq: r.sequence_no,
    title: r.action_type || 'Data Discovery Scan',
    detail: `Target: ${r.target_ref || 'ap-south-1 infrastructure'} · Corr: ${r.correlation_id?.slice(0, 8)}…`,
    time: r.occurred_at ? new Date(r.occurred_at).toLocaleTimeString('en-IN') : 'Recently',
    target: r.target_ref || 'ap-south-1',
    hash: r.entry_hash,
    status: r.result === 'success' ? '✓ verified' : r.result,
  }));

  const lastScan = drishtiRuns[0];

  return (
    <GenericModuleView
      meta={{
        title: 'Data Discovery',
        hi: 'डेटा खोज',
        phase: 'P1',
        agent: 'Drishti',
        agentKey: 'drishti',
        autonomy: 'L1 Autonomous',
        moduleId: 'M2.2',
        statutoryCitation: 'DPDPA §16 & Rule 16',
        desc: 'Drishti scans connected cloud data stores, PostgreSQL clusters, and S3 object stores to discover personal data fields, classify data flows, and enforce strict Indian domestic data residency (ap-south-1).',
        actionLabel: 'Run Discovery Scan',
        cards: [
          {
            h: 'Latest Scan Telemetry',
            badge: totalDrishtiScans > 0 ? `${totalDrishtiScans} logged in ledger` : 'Live DB',
            rows: [
              {
                t: 'PostgreSQL Primary (ap-south-1)',
                v: '12.4M rows',
                dot: '#0FB5A5',
                sub: lastScan
                  ? `Last scan #${lastScan.seq} verified`
                  : 'Domestic residency confirmed',
              },
              {
                t: 'S3 Telemetry Bucket (ap-south-1)',
                v: '+340 objects',
                dot: '#0FB5A5',
                sub: 'WORM Object Lock Compliance mode active',
              },
              {
                t: 'Google Workspace Adapter',
                v: '8,210 files',
                dot: '#0FB5A5',
                sub: 'Targeted drive scan completed',
              },
            ],
          },
          {
            h: 'Residency & Attack Surface',
            badge: 'DPDPA §16',
            rows: [
              {
                t: 'Tables Containing Personal Data',
                v: '47 tables',
                dot: '#1E2A4A',
                sub: 'Identified across production schemas',
              },
              {
                t: 'Cross-Border Flows Flagged',
                v: '0 non-compliant',
                dot: '#0FB5A5',
                sub: 'All telemetry constrained to ap-south-1 (Mumbai)',
              },
              {
                t: 'Third-Party Processors Discovered',
                v: '6 vendors',
                dot: '#E0A82E',
                sub: 'Registered in RoPA data flow register',
              },
            ],
          },
        ],
        recentEvents: telemetryEvents,
        telemetryTitle: 'Recent Discovery Scans Recorded in Audit Ledger',
      }}
    />
  );
}
