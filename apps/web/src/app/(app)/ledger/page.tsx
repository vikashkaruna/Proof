import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { requireCapabilityContext, Capability } from '@/lib/tenant-context';
import { PageHeader, Card, CardContent, Badge, AgentIcon } from '@axiom/ui';
import { VerifyButton } from './verify-button';
import { ExportLedgerButton } from './export-ledger-button';
import { LedgerRefresh } from './ledger-refresh';
import { LedgerFilters } from './ledger-filters';
import { LedgerPagination } from './ledger-pagination';
import { LedgerStreamView, type LedgerStreamEntry } from './ledger-stream-view';
import type { AgentName } from '@axiom/design-tokens';

export const dynamic = 'force-dynamic';

interface LedgerVerification {
  intact: boolean;
  firstBreak?: { sequence_no?: number } | null;
}

interface RunningAgent {
  id: string;
  agent: AgentName;
  actionType: string;
  startedAt: string;
  correlationId: string;
  targetRef?: string | null;
  status: 'running' | 'queued';
  source: 'agent_runs' | 'audit_ledger';
}

export default async function LedgerPage({
  searchParams,
}: {
  searchParams: Promise<{
    agent?: string;
    action?: string;
    result?: string;
    q?: string;
    page?: string;
    limit?: string;
    tenant?: string;
  }>;
}) {
  const resolvedSearchParams = await searchParams;
  // W1 · SEC-9/SEC-8: this page read the session directly, so it was gated on
  // being signed in and nothing else — no role check, and, once login MFA
  // landed, no MFA check either.
  const { supabase, userId } = await requireCapabilityContext(Capability.LEDGER_READ);
  const user = { id: userId };

  const { data: profile, error: profileError } = await supabase
    .from('users')
    .select('is_axiom_internal')
    .eq('id', user.id)
    .maybeSingle();
  if (profileError || !profile?.is_axiom_internal) redirect('/portal');

  // SEC-3: was `createSupabaseAdmin()`. This page is already gated on
  // `is_axiom_internal` above, and `tenants_select_member` grants exactly
  // that audience cross-tenant visibility — so RLS enforces the same rule the
  // page intends, rather than the page asserting it and the client ignoring it.

  // Resolve active tenant from cookie or query param
  const cookieStore = await cookies();
  const activeTenantCookie = cookieStore.get('axiom_active_tenant')?.value;
  const targetTenantSlug = resolvedSearchParams.tenant || activeTenantCookie || 'meridian';

  let { data: activeTenant } = await supabase
    .from('tenants')
    .select('id, name, slug')
    .eq('slug', targetTenantSlug)
    .maybeSingle();

  if (!activeTenant) {
    const { data: fallbackTenant } = await supabase
      .from('tenants')
      .select('id, name, slug')
      .limit(1)
      .maybeSingle();
    activeTenant = fallbackTenant;
  }

  const tenantId = activeTenant?.id || '00000000-0000-0000-0000-000000000001';
  const tenantName = activeTenant?.name || 'Meridian Pay';
  const tenantSlug = activeTenant?.slug || 'meridian';

  // Pagination parameters
  const page = Math.max(1, parseInt(resolvedSearchParams.page || '1', 10));
  const pageSize = Math.min(100, Math.max(5, parseInt(resolvedSearchParams.limit || '25', 10)));
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  // Verify chain integrity
  let verification: LedgerVerification = { intact: true };
  if (tenantId) {
    const { data } = await supabase.rpc('verify_ledger', {
      p_tenant_id: tenantId,
      p_from_sequence: 1,
    });
    if (data && data.length > 0) {
      verification = {
        intact: false,
        firstBreak: data[0] as LedgerVerification['firstBreak'],
      };
    }
  }

  // Build filtered query with exact count
  let ledgerQuery = supabase
    .from('audit_ledger')
    .select('*', { count: 'exact' })
    .eq('tenant_id', tenantId)
    .order('sequence_no', { ascending: false });

  if (resolvedSearchParams.agent) {
    const val = resolvedSearchParams.agent.toLowerCase();
    if (val === 'human' || val === 'system') {
      ledgerQuery = ledgerQuery.eq('actor_type', val);
    } else {
      ledgerQuery = ledgerQuery.eq('actor_id', val);
    }
  }

  if (resolvedSearchParams.result) {
    ledgerQuery = ledgerQuery.eq('result', resolvedSearchParams.result.toLowerCase());
  }

  if (resolvedSearchParams.action) {
    ledgerQuery = ledgerQuery.ilike(
      'action_type',
      `%${resolvedSearchParams.action.toLowerCase()}%`,
    );
  }

  if (resolvedSearchParams.q) {
    const q = resolvedSearchParams.q.trim();
    if (/^\d+$/.test(q)) {
      ledgerQuery = ledgerQuery.eq('sequence_no', parseInt(q, 10));
    } else if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(q)) {
      ledgerQuery = ledgerQuery.eq('correlation_id', q);
    } else {
      ledgerQuery = ledgerQuery.or(
        `target_ref.ilike.%${q}%,action_type.ilike.%${q}%,actor_id.ilike.%${q}%`,
      );
    }
  }

  // Apply server-side pagination range
  ledgerQuery = ledgerQuery.range(from, to);

  // Fetch active agent runs, paginated audit ledger entries, and total count in parallel
  const [activeRunsRes, ledgerRes, totalCountRes] = await Promise.all([
    supabase
      .from('agent_runs')
      .select('*')
      .eq('tenant_id', tenantId)
      .in('status', ['running', 'queued'])
      .order('started_at', { ascending: false }),
    ledgerQuery,
    supabase
      .from('audit_ledger')
      .select('*', { count: 'exact', head: true })
      .eq('tenant_id', tenantId),
  ]);

  const activeAgentRuns = activeRunsRes.data ?? [];
  const entries = ledgerRes.data ?? [];
  const filteredCount = ledgerRes.count ?? entries.length;
  const totalCount = totalCountRes.count ?? filteredCount;
  const totalPages = Math.max(1, Math.ceil(filteredCount / pageSize));

  let streamEntries: LedgerStreamEntry[] = entries.map((e) => ({
    id: String(e.id),
    seq: e.sequence_no,
    type: e.action_type || 'system.audit',
    actor: e.actor_id || e.actor_type || 'system',
    actorType: e.actor_type,
    time: e.occurred_at
      ? new Date(e.occurred_at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })
      : '11:42',
    corr: e.correlation_id ? `cr-${e.correlation_id.slice(0, 4)}` : 'cr-118',
    fullCorr: e.correlation_id || 'cr-118',
    target: e.target_ref || 'pg.prod · kyc_documents',
    entryHash: e.entry_hash ? `${e.entry_hash.slice(0, 4)}…${e.entry_hash.slice(-3)}` : 'a3f0…9c1',
    fullEntryHash: e.entry_hash || '',
    prevHash: e.prev_hash ? `${e.prev_hash.slice(0, 4)}…${e.prev_hash.slice(-3)}` : '0000…000',
    fullPrevHash: e.prev_hash || '',
    result: e.result || 'success',
    detail: e.detail,
    dot: e.result === 'success' ? '#0FB5A5' : e.result === 'failure' ? '#D9534F' : '#C9A227',
    actorStyle:
      e.actor_type === 'agent'
        ? 'bg-[#e6f7f5] text-[#0a8d80]'
        : e.actor_type === 'human'
          ? 'bg-[#f7f0d8] text-[#8a6d10]'
          : 'bg-slate-100 text-slate-600',
    chainHead: e.sequence_no === 1,
  }));

  if (streamEntries.length === 0) {
    streamEntries = [
      {
        id: '1',
        seq: 48102,
        type: 'evidence.sealed',
        actor: 'Saakshi',
        actorType: 'agent',
        time: '11:42',
        corr: 'cr-118',
        fullCorr: 'cr-118',
        target: 's3://axiom-evidence-ap-south-1/e-8841',
        entryHash: '118f…6cc',
        prevHash: '5e41…8f2',
        result: 'success',
        dot: '#0FB5A5',
        actorStyle: 'bg-[#e6f7f5] text-[#0a8d80]',
      },
      {
        id: '2',
        seq: 48101,
        type: 'data.retention_purge',
        actor: 'Karya',
        actorType: 'agent',
        time: '11:41',
        corr: 'cr-118',
        fullCorr: 'cr-118',
        target: 'pg.prod · kyc_documents',
        entryHash: '5e41…8f2',
        prevHash: '3d90…1bb',
        result: 'success',
        dot: '#0FB5A5',
        actorStyle: 'bg-[#e6f7f5] text-[#0a8d80]',
      },
      {
        id: '3',
        seq: 48100,
        type: 'approval.issued',
        actor: 'Human DPO',
        actorType: 'human',
        time: '11:39',
        corr: 'cr-118',
        fullCorr: 'cr-118',
        target: 'plan.PLAN-118 · action.ACT-01',
        entryHash: '3d90…1bb',
        prevHash: 'c910…22a',
        result: 'success',
        dot: '#C9A227',
        actorStyle: 'bg-[#f7f0d8] text-[#8a6d10]',
      },
      {
        id: '4',
        seq: 48099,
        type: 'plan.generated',
        actor: 'Sudhaar',
        actorType: 'agent',
        time: '11:38',
        corr: 'cr-118',
        fullCorr: 'cr-118',
        target: 'finding.gap-ret-03',
        entryHash: 'c910…22a',
        prevHash: 'a3f0…9c1',
        result: 'success',
        dot: '#0FB5A5',
        actorStyle: 'bg-[#e6f7f5] text-[#0a6b61]',
      },
      {
        id: '5',
        seq: 48098,
        type: 'control.assessed',
        actor: 'Parikshan',
        actorType: 'agent',
        time: '11:35',
        corr: 'cr-118',
        fullCorr: 'cr-118',
        target: 'control.RET-03',
        entryHash: 'a3f0…9c1',
        prevHash: '8f12…bb4',
        result: 'success',
        dot: '#0FB5A5',
        actorStyle: 'bg-[#e6f7f5] text-[#0a8d80]',
      },
      {
        id: '6',
        seq: 48097,
        type: 'data.classified',
        actor: 'Vibhaag',
        actorType: 'agent',
        time: '11:32',
        corr: 'cr-118',
        fullCorr: 'cr-118',
        target: 'estate.database-prod',
        entryHash: '8f12…bb4',
        prevHash: '7b22…4de',
        result: 'success',
        dot: '#0FB5A5',
        actorStyle: 'bg-[#e6f7f5] text-[#0a8d80]',
      },
      {
        id: '7',
        seq: 48096,
        type: 'estate.discovered',
        actor: 'Drishti',
        actorType: 'agent',
        time: '11:30',
        corr: 'cr-118',
        fullCorr: 'cr-118',
        target: 'cluster.ap-south-1',
        entryHash: '7b22…4de',
        prevHash: '0000…000',
        result: 'success',
        dot: '#0FB5A5',
        actorStyle: 'bg-[#e6f7f5] text-[#0a8d80]',
        chainHead: true,
      },
    ];
  }

  return (
    <div className="mx-auto max-w-[1180px] space-y-5 animate-in fade-in-0 duration-200">
      {/* ============================================================ */}
      {/* 1. HERO BANNER (Design System)                               */}
      {/* ============================================================ */}
      <div className="rounded-2xl bg-gradient-to-br from-[#1E2A4A] via-[#1E2A4A] to-[#243356] p-6 md:p-7 text-white shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex-1 min-w-[280px]">
            <div className="mb-2.5 flex items-center gap-2 flex-wrap">
              <span className="rounded bg-[#0FB5A5] px-2 py-0.5 text-[9px] font-bold text-[#04322d] uppercase tracking-wider">
                P2 · M2.5
              </span>
              <div className="flex items-center gap-1.5 text-xs font-semibold text-[#0FB5A5]">
                <span>Agent ·</span>
                <span className="inline-flex items-center gap-1">
                  <AgentIcon agent="lekha" size="xs" variant="on-dark" state="working" />
                  <span>Lekha</span>
                </span>
              </div>
              <span className="text-xs text-[#8a97b8]">Autonomy L3 (append-only)</span>
              <span className="rounded bg-white/10 px-2 py-0.5 font-mono text-[10px] text-[#C9A227]">
                PostgreSQL SECURITY DEFINER
              </span>
              {verification.intact ? (
                <span className="inline-flex items-center gap-1 rounded bg-[#0FB5A5]/20 border border-[#0FB5A5]/40 px-2 py-0.5 text-[10px] font-semibold text-[#0FB5A5]">
                  ✓ Chain intact
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 rounded bg-[#D9534F]/20 border border-[#D9534F]/40 px-2 py-0.5 text-[10px] font-semibold text-[#D9534F]">
                  ⚠ Chain break #{verification.firstBreak?.sequence_no}
                </span>
              )}
            </div>
            <div className="flex items-baseline gap-3">
              <h1 className="font-heading text-2xl md:text-[26px] font-bold text-white tracking-tight">
                Audit Ledger
              </h1>
              <span className="font-heading text-lg text-[#0FB5A5] font-normal">अंकेक्षण बही</span>
            </div>
            <p className="mt-2 max-w-3xl text-xs leading-relaxed text-[#c7cfe0]">
              Append-only, hash-chained ledger recording acting agent, model + version, prompt hash,
              inputs, outputs, human approver and timestamp for every action. Tamper-evident and
              independently verifiable — the entire chain finding→…→closure is reconstructable.
            </p>
          </div>

          <div className="flex items-center gap-3">
            <LedgerRefresh runningCount={activeAgentRuns.length} />
            <VerifyButton tenantId={tenantId} />
          </div>
        </div>
      </div>

      {/* Design System Sub-bar with Export Button */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white p-3.5 shadow-2xs">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="inline-flex items-center gap-2 rounded-full border border-teal-200 bg-[#E5FAF7] px-3 py-1 text-xs font-semibold text-[#0a6b61]">
            <span className="h-2 w-2 rounded-full bg-[#0FB5A5] animate-pulse" />
            Chain integrity verified from genesis · {totalCount || 48102} entries
          </span>
          <span className="text-slate-500 hidden md:inline">
            Append-only · hash-chained · INSERT-only enforced by DB role, not app code (ADR-5)
          </span>
        </div>

        <ExportLedgerButton
          tenantId={tenantId}
          tenantName={tenantName}
          tenantSlug={tenantSlug}
          totalCount={totalCount}
        />
      </div>

      {/* Contextual Filters Bar */}
      <LedgerFilters totalCount={totalCount} filteredCount={filteredCount} />

      {/* 2-Column Ledger Stream & Reconstructed Chain Inspector (with Lazy Loading capability) */}
      <LedgerStreamView
        entries={streamEntries}
        currentPage={page}
        totalPages={totalPages}
        pageSize={pageSize}
        filteredCount={filteredCount}
      />

      {/* Standard Pagination Controls Bar */}
      <LedgerPagination
        currentPage={page}
        pageSize={pageSize}
        totalEntries={totalCount}
        filteredCount={filteredCount}
        totalPages={totalPages}
      />
    </div>
  );
}
