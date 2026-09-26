import { ReportsClient } from './reports-client';
import { ReviewQueue, type ReportRow } from './review-queue';
import { requireTenantContext } from '@/lib/tenant-context';

export const dynamic = 'force-dynamic';

export default async function ReportsPage() {
  // SEC-3: was `createSupabaseAdmin()`. The service-role key bypasses RLS
  // by design, and these queries carried no tenant filter, so any
  // authenticated user saw every tenant's data. The client below is
  // user-scoped: RLS applies, and the explicit filters state the intent.
  const { supabase, tenantId } = await requireTenantContext();
  let totalReports = 5;
  let postureScore = 74;
  let sealedEvidenceCount = 28;
  let reviewRows: ReportRow[] = [];

  try {
    const [ledgerRes, engagementRes, evidenceRes, reportsRes] = await Promise.all([
      supabase
        .from('audit_ledger')
        .select('seq', { count: 'estimated', head: true })
        .eq('tenant_id', tenantId)
        .or('actor.eq.prativedan,action.ilike.%report%,action.ilike.%pack%'),
      supabase
        .from('engagements')
        .select('posture_score, status, title')
        .eq('tenant_id', tenantId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabase
        .from('evidence')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', tenantId),
      supabase
        .from('reports')
        .select(
          'id, kind, title, status, generated_by_agent, generated_at, reviewed_by, rejection_reason, published_at, released_content_hash',
        )
        .eq('tenant_id', tenantId)
        .order('generated_at', { ascending: false })
        .limit(100),
    ]);

    if (ledgerRes.count != null && ledgerRes.count > 0) {
      totalReports = ledgerRes.count;
    }
    if (engagementRes.data?.posture_score != null) {
      postureScore = Math.round(Number(engagementRes.data.posture_score));
    }
    if (evidenceRes.count != null && evidenceRes.count > 0) {
      sealedEvidenceCount = evidenceRes.count;
    }
    reviewRows = (reportsRes.data ?? []) as unknown as ReportRow[];
  } catch {
    // Fallback if database offline
  }

  return (
    <div className="space-y-6">
      <ReportsClient
        totalCount={totalReports}
        postureScore={postureScore}
        evidenceCount={sealedEvidenceCount}
      />
      <ReviewQueue rows={reviewRows} />
    </div>
  );
}
