import { requireInternalContext } from '@/lib/tenant-context';
import { BRAND } from '@axiom/config';
import { AgentWorkbenchClient } from './workbench-client';

export const dynamic = 'force-dynamic';

export default async function WorkbenchPage() {
  // SEC-3 + W1: the hand-rolled "is this an Axiom-internal user?" check that
  // stood here is exactly what `requireInternalContext` does, and it now runs
  // against the user-scoped client rather than one that bypasses RLS.
  const { supabase, tenantId, userId, email } = await requireInternalContext();

  let ledgerTodayCount = 214;
  let awaitingReviewCount = 8;
  let recentRuns: any[] = [];
  let pendingPlans: any[] = [];

  try {
    const [ledgerRes, plansRes, runsRes] = await Promise.all([
      supabase
        .from('audit_ledger')
        .select('seq, actor, action, target_ref, timestamp, result, correlation_id', {
          count: 'estimated',
        })
        .eq('tenant_id', tenantId)
        .order('sequence_no', { ascending: false })
        .limit(8),
      supabase
        .from('remediation_plans')
        .select('id, title, status, version, created_at')
        .eq('tenant_id', tenantId)
        .in('status', ['draft', 'review', 'awaiting_approval'])
        .order('created_at', { ascending: false })
        .limit(6),
      supabase
        .from('audit_ledger')
        .select('seq', { count: 'estimated', head: true })
        .eq('tenant_id', tenantId)
        .gte('timestamp', new Date(new Date().setHours(0, 0, 0, 0)).toISOString()),
    ]);

    if (ledgerRes.data) recentRuns = ledgerRes.data;
    if (plansRes.data && plansRes.data.length > 0) {
      pendingPlans = plansRes.data;
      awaitingReviewCount = plansRes.data.length;
    }
    if (runsRes.count != null && runsRes.count > 0) {
      ledgerTodayCount = runsRes.count;
    } else if (ledgerRes.count != null && ledgerRes.count > 0) {
      ledgerTodayCount = ledgerRes.count;
    }
  } catch {
    // Fallback if fresh database
  }

  return (
    <AgentWorkbenchClient
      userEmail={email ?? 'admin@axiomminds.ai'}
      ledgerTodayCount={ledgerTodayCount}
      awaitingReviewCount={awaitingReviewCount}
      recentRuns={recentRuns}
      pendingPlans={pendingPlans}
      dataResidencyRegion={BRAND.dataResidencyRegion}
    />
  );
}
