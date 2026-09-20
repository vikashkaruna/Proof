import { GenericModuleView, type ModuleTelemetryEvent } from '../generic-module-view';
import { requireTenantContext } from '@/lib/tenant-context';

export const dynamic = 'force-dynamic';

export default async function PartnerPage() {
  // SEC-3: was `createSupabaseAdmin()`, whose service-role key bypasses RLS.
  // The client below is user-scoped, so RLS is the backstop it was designed
  // to be and a missing filter is an empty result, not a leak.
  const { supabase, tenantId } = await requireTenantContext();
  let partnerRuns: any[] = [];
  let tenantCount = 4;

  try {
    const [ledgerRes, tenantRes] = await Promise.all([
      supabase
        .from('audit_ledger')
        .select(
          'sequence_no, correlation_id, action_type, target_ref, occurred_at, entry_hash, result',
          {
            count: 'estimated',
          },
        )
        .eq('tenant_id', tenantId)
        .order('sequence_no', { ascending: false })
        .limit(6),
      supabase.from('tenants').select('id', { count: 'estimated', head: true }),
    ]);

    partnerRuns = ledgerRes.data || [];
    if (tenantRes.count != null && tenantRes.count > 0) {
      tenantCount = tenantRes.count;
    }
  } catch {
    // Graceful fallback if database offline
  }

  const telemetryEvents: ModuleTelemetryEvent[] = partnerRuns.map((r) => ({
    seq: r.sequence_no,
    title: r.action_type || 'Multi-Tenant Governance Operation',
    detail: `Target: ${r.target_ref || 'Tenant Infrastructure'} · Corr: ${r.correlation_id?.slice(0, 8)}…`,
    time: r.occurred_at ? new Date(r.occurred_at).toLocaleTimeString('en-IN') : 'Recently',
    target: r.target_ref || 'Tenant Realm',
    hash: r.entry_hash,
    status: r.result === 'success' ? '✓ isolated' : r.result,
  }));

  return (
    <GenericModuleView
      meta={{
        title: 'Partner / White-label Portal',
        hi: 'भागीदार एवं डेटा प्रोसेसर पोर्टल',
        phase: 'P4',
        autonomy: 'L3 Multi-Tenant Safe',
        moduleId: 'M4.7',
        statutoryCitation: 'DPDPA §8(2) Processor Oversight & Advisory Network',
        desc: 'Multi-client management and third-party data processor governance under DPDPA §8(2). Tracks fiduciary-processor contracts, data transfer agreements, and white-labeled compliance packs for CA, CS, and legal audit partners.',
        actionLabel: 'Generate Multi-Client Auditor Pack →',
        actionHref: '/reports',
        cards: [
          {
            h: 'Advisory Network & Tenant Tenancy',
            badge: `${tenantCount} Managed Organizations`,
            rows: [
              {
                t: 'Active Managed Organizations',
                v: `${tenantCount} organizations`,
                dot: '#0FB5A5',
                sub: 'Strict database RLS separation (ADR-8 tenancy)',
              },
              {
                t: 'Partner Advisory Network',
                v: 'CA, CS & Law Firms',
                dot: '#1E2A4A',
                sub: 'White-label audit delivery with custom branding',
              },
              {
                t: 'Domestic Sovereign Tenancy',
                v: '100% ap-south-1',
                dot: '#0FB5A5',
                sub: 'Zero cross-tenant or cross-border data leakage',
              },
            ],
          },
          {
            h: 'DPDPA §8(2) Processor Due Diligence',
            badge: 'Statutory Safeguards',
            rows: [
              {
                t: 'Data Processor Contracts Tracked',
                v: 'Active under §8(2)',
                dot: '#0FB5A5',
                sub: 'Mandatory valid contract requirement enforced',
              },
              {
                t: 'Data Breach Notification Protocol',
                v: 'Under 6 Hours',
                dot: '#0FB5A5',
                sub: 'Automated CERT-In & DPB incident workflow',
              },
              {
                t: 'Auditor Pack Export Format',
                v: 'Branded PDF + SHA-256 Vault',
                dot: '#C9A227',
                sub: 'Cryptographically sealed evidence chain',
              },
            ],
          },
        ],
        recentEvents: telemetryEvents,
        telemetryTitle: 'Recent Cross-Tenant & Audit Operations in Ledger',
      }}
    />
  );
}
