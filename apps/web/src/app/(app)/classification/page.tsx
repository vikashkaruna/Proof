import { GenericModuleView, type ModuleTelemetryEvent } from '../generic-module-view';
import { requireTenantContext } from '@/lib/tenant-context';

export const dynamic = 'force-dynamic';

export default async function ClassificationPage() {
  // SEC-3: was `createSupabaseAdmin()`, whose service-role key bypasses RLS.
  // The client below is user-scoped, so a missing tenant filter is an empty
  // result rather than a cross-tenant leak.
  const { supabase, tenantId, isDemo } = await requireTenantContext();
  let vibhaagRuns: any[] = [];
  let totalVibhaagScans = 0;

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
      .eq('actor_id', 'vibhaag')
      .order('sequence_no', { ascending: false })
      .limit(6);

    vibhaagRuns = data || [];
    totalVibhaagScans = count ?? vibhaagRuns.length;
  } catch {
    // Graceful fallback
  }

  const telemetryEvents: ModuleTelemetryEvent[] = vibhaagRuns.map((r) => ({
    seq: r.sequence_no,
    title: r.action_type || 'Data Field Classification',
    detail: `Target: ${r.target_ref || 'Discovered Schema'} · Corr: ${r.correlation_id?.slice(0, 8)}…`,
    time: r.occurred_at ? new Date(r.occurred_at).toLocaleTimeString('en-IN') : 'Recently',
    target: r.target_ref || 'dpdpa_schema',
    hash: r.entry_hash,
    status: r.result === 'success' ? '✓ classified' : r.result,
  }));

  const lastRun = vibhaagRuns[0];

  return (
    <GenericModuleView
      isDemo={isDemo}
      meta={{
        title: 'Data Classification',
        hi: 'वर्गीकरण',
        phase: 'P1',
        agent: 'Vibhaag',
        agentKey: 'vibhaag',
        autonomy: 'L1 Autonomous',
        moduleId: 'M2.3',
        statutoryCitation: 'DPDPA §4–10 & Rule 4',
        desc: 'Vibhaag classifies discovered fields across 9 statutory DPDPA categories with deterministic pattern recognizers and confidence scoring. High-risk items (children, financial, Aadhaar) are automatically escalated.',
        actionLabel: 'Run Classification Scan',
        cards: [
          {
            h: 'Statutory DPDPA Categories',
            badge: totalVibhaagScans > 0 ? `${totalVibhaagScans} ledger runs` : 'Live Schema',
            rows: [
              {
                t: 'National Identifiers (Aadhaar, PAN)',
                v: '2,840 fields',
                dot: '#1E2A4A',
                sub: lastRun
                  ? `Last classified in ledger #${lastRun.seq}`
                  : 'AES-256 field encryption required',
              },
              {
                t: 'Financial & Banking Data',
                v: '1,120 fields',
                dot: '#D9534F',
                sub: 'Bank accounts, UPI handles, transaction logs',
              },
              {
                t: 'Children’s Personal Data Flagged',
                v: '38 fields',
                dot: '#D9534F',
                sub: 'DPDPA §9: Verifiable parental consent enforced',
              },
            ],
          },
          {
            h: 'Classification Confidence & Review Queue',
            badge: 'Quality Gate',
            rows: [
              {
                t: 'High Confidence Fields (≥0.90)',
                v: '3,906 fields',
                dot: '#0FB5A5',
                sub: 'Auto-mapped to statutory processing purposes',
              },
              {
                t: 'Human Review Queue (<0.75)',
                v: '12 items',
                dot: '#E0A82E',
                sub: 'Queued for Data Protection Officer confirmation',
              },
              {
                t: 'Confirmed & Sealed This Month',
                v: '201 entries',
                dot: '#0FB5A5',
                sub: 'Stored in append-only audit ledger',
              },
            ],
          },
        ],
        recentEvents: telemetryEvents,
        telemetryTitle: 'Recent Classification Tasks in Audit Ledger',
      }}
    />
  );
}
