import { GenericModuleView, type ModuleTelemetryEvent } from '../generic-module-view';
import { requireTenantContext } from '@/lib/tenant-context';

export const dynamic = 'force-dynamic';

export default async function ExecutionPage() {
  // SEC-3: was `createSupabaseAdmin()`, whose service-role key bypasses RLS.
  // The client below is user-scoped, so RLS is the backstop it was designed
  // to be and a missing filter is an empty result, not a leak.
  const { supabase, tenantId } = await requireTenantContext();
  let plans: any[] = [];
  let actions: any[] = [];
  let executionLedger: any[] = [];

  try {
    const [plansRes, actionsRes, ledgerRes] = await Promise.all([
      supabase
        .from('remediation_plans')
        .select('id, title, status, created_at')
        .eq('tenant_id', tenantId)
        .order('created_at', { ascending: false })
        .limit(3),
      supabase
        .from('remediation_actions')
        .select('id, plan_id, risk_tier, dry_run_status, rollback_validated, rollback_ref')
        .eq('tenant_id', tenantId)
        .limit(10),
      supabase
        .from('audit_ledger')
        .select(
          'sequence_no, correlation_id, action_type, target_ref, occurred_at, entry_hash, result',
        )
        .eq('tenant_id', tenantId)
        .eq('actor_id', 'karya')
        .order('sequence_no', { ascending: false })
        .limit(6),
    ]);

    plans = plansRes.data || [];
    actions = actionsRes.data || [];
    executionLedger = ledgerRes.data || [];
  } catch {
    // Graceful fallback
  }

  const telemetryEvents: ModuleTelemetryEvent[] = executionLedger.map((r) => ({
    seq: r.sequence_no,
    title: r.action_type || 'Remediation Mutation Executed',
    detail: `Target: ${r.target_ref || 'Production Infrastructure'} · Corr: ${r.correlation_id?.slice(0, 8)}…`,
    time: r.occurred_at ? new Date(r.occurred_at).toLocaleTimeString('en-IN') : 'Recently',
    target: r.target_ref || 'prod_system',
    hash: r.entry_hash,
    status: r.result === 'success' ? '✓ verified' : r.result,
  }));

  const verifiedActions = actions.filter((a) => a.rollback_validated).length;

  return (
    <GenericModuleView
      meta={{
        title: 'Execution & Rollback',
        hi: 'निष्पादन',
        phase: 'P3',
        agent: 'Karya',
        agentKey: 'karya',
        autonomy: 'L2 (token-gated)',
        moduleId: 'M3.4',
        statutoryCitation: 'ADR-1, ADR-2 & BR-2',
        desc: 'Karya executes only approved actions — batch with configurable concurrency and stop-on-failure, or individually. Pre/post state captured per action; blast-radius caps and kill switch enforced.',
        actionLabel: 'Review & Approve Actions in Console →',
        actionHref: '/approval',
        cards: [
          {
            h: 'Recent executions',
            rows: [
              {
                t: 'Batch RB-118 · 7 actions',
                v: '✓ verified',
                dot: '#0FB5A5',
              },
              {
                t: 'ACT-09 rollback exercised',
                v: '✓ reversed',
                dot: '#0FB5A5',
              },
              {
                t: 'ACT-14 halted — blast cap',
                v: 'escalated',
                dot: '#D9534F',
              },
            ],
          },
          {
            h: 'Guardrails',
            rows: [
              {
                t: 'Blast-radius cap / batch',
                v: '5,000 rec',
                dot: '#1E2A4A',
              },
              {
                t: 'Concurrency',
                v: '4',
                dot: '#1E2A4A',
              },
              {
                t: 'Kill switch',
                v: 'armed',
                dot: '#0FB5A5',
              },
            ],
          },
        ],
        recentEvents: telemetryEvents,
        telemetryTitle: 'Recent Executions & Rollbacks in Audit Ledger',
      }}
    />
  );
}
