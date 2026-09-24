import { requireInternalContext } from '@/lib/tenant-context';
import { BRAND, loadWebEnv } from '@axiom/config';
import { AgentWorkbenchClient } from './workbench-client';

export const dynamic = 'force-dynamic';

export default async function WorkbenchPage() {
  // SEC-3 + W1: the hand-rolled "is this an Axiom-internal user?" check that
  // stood here is exactly what `requireInternalContext` does, and it now runs
  // against the user-scoped client rather than one that bypasses RLS.
  const { supabase, tenantId, email } = await requireInternalContext();

  // C-W0-7: counts are read or shown as unavailable — never a sample number.
  // (The previous query named ledger columns that do not exist, so it always
  // failed and the page always displayed invented fallback counts.)
  const startOfDay = new Date(new Date().setHours(0, 0, 0, 0)).toISOString();
  const [ledgerRes, plansRes, todayRes] = await Promise.all([
    supabase
      .from('audit_ledger')
      .select('sequence_no, actor_id, action_type, target_ref, occurred_at, result, correlation_id')
      .eq('tenant_id', tenantId)
      .order('sequence_no', { ascending: false })
      .limit(8),
    supabase
      .from('remediation_plans')
      .select('id, title, status, version, created_at', { count: 'exact' })
      .eq('tenant_id', tenantId)
      .in('status', ['draft', 'review'])
      .order('created_at', { ascending: false })
      .limit(6),
    supabase
      .from('audit_ledger')
      .select('sequence_no', { count: 'exact', head: true })
      .eq('tenant_id', tenantId)
      .gte('occurred_at', startOfDay),
  ]);
  const loadError = Boolean(ledgerRes.error || plansRes.error || todayRes.error);

  return (
    <AgentWorkbenchClient
      userEmail={email ?? ''}
      ledgerTodayCount={todayRes.error ? null : (todayRes.count ?? null)}
      awaitingReviewCount={plansRes.error ? null : (plansRes.count ?? null)}
      recentRuns={(ledgerRes.data ?? []).map((r) => ({
        seq: Number(r.sequence_no),
        actor: r.actor_id,
        action: r.action_type,
        target_ref: r.target_ref,
        correlation_id: r.correlation_id,
        timestamp: r.occurred_at,
        result: r.result,
      }))}
      pendingPlans={plansRes.data ?? []}
      dataResidencyRegion={BRAND.dataResidencyRegion}
      environment={loadWebEnv().ENVIRONMENT ?? 'local'}
      loadError={loadError}
    />
  );
}
