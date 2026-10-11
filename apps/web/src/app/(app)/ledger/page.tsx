import { requireCapabilityContext, Capability } from '@/lib/tenant-context';
import { isSafeLedgerSearch, ledgerPageNumber } from '@/lib/ledger-search';
import { PageHeader } from '@axiom/ui';
import { VerifyButton } from './verify-button';
import { ExportLedgerButton } from './export-ledger-button';
import { LedgerRefresh } from './ledger-refresh';
import { LedgerFilters } from './ledger-filters';
import { LedgerPagination } from './ledger-pagination';
import { LedgerStreamView, type LedgerStreamEntry } from './ledger-stream-view';
import type { AgentName } from '@axiom/design-tokens';
import { moduleBarProps } from '@/lib/module-bar';

export const dynamic = 'force-dynamic';

interface LedgerVerification {
  status: 'intact' | 'broken' | 'unavailable';
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
  const { supabase, tenantId, tenantName, tenantSlug } = await requireCapabilityContext(
    Capability.LEDGER_READ,
    resolvedSearchParams.tenant,
  );
  if (resolvedSearchParams.tenant && tenantSlug !== resolvedSearchParams.tenant) {
    throw new Error('Requested ledger tenant is unavailable');
  }
  // The ledger is a tenant surface: every client role holds LEDGER_READ, and
  // `audit_ledger_select_member` lets tenant members read their own chain.
  // An older `is_axiom_internal` check here sent every client user who opened
  // Audit Ledger to the Client Portal instead. Every query below is scoped to
  // the verified `tenantId`, and RLS enforces the same rule.

  // Pagination parameters
  const page = ledgerPageNumber(resolvedSearchParams.page, 1, 1_000_000);
  const pageSize = Math.max(5, ledgerPageNumber(resolvedSearchParams.limit, 25, 100));
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  // Verify chain integrity
  let verification: LedgerVerification = { status: 'unavailable' };
  const { data: verificationRows, error: verificationError } = await supabase.rpc('verify_ledger', {
    p_tenant_id: tenantId,
    p_from_sequence: 1,
  });
  if (!verificationError && Array.isArray(verificationRows)) {
    verification =
      verificationRows.length > 0
        ? { status: 'broken', firstBreak: verificationRows[0] as LedgerVerification['firstBreak'] }
        : { status: 'intact' };
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
    if (!isSafeLedgerSearch(q)) throw new Error('Invalid ledger search query');
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

  if (
    activeRunsRes.error ||
    ledgerRes.error ||
    totalCountRes.error ||
    !Array.isArray(activeRunsRes.data) ||
    !Array.isArray(ledgerRes.data) ||
    typeof ledgerRes.count !== 'number' ||
    !Number.isSafeInteger(ledgerRes.count) ||
    ledgerRes.count < 0 ||
    typeof totalCountRes.count !== 'number' ||
    !Number.isSafeInteger(totalCountRes.count) ||
    totalCountRes.count < 0
  ) {
    throw new Error('Ledger records are unavailable. No audit status can be inferred.');
  }

  const activeAgentRuns = activeRunsRes.data;
  const entries = ledgerRes.data;
  const filteredCount = ledgerRes.count;
  const totalCount = totalCountRes.count;
  const totalPages = Math.max(1, Math.ceil(filteredCount / pageSize));

  const streamEntries: LedgerStreamEntry[] = entries.map((e) => ({
    id: String(e.id),
    seq: e.sequence_no,
    type: e.action_type || 'system.audit',
    actor: e.actor_id || e.actor_type || 'system',
    actorType: e.actor_type,
    time: e.occurred_at
      ? new Date(e.occurred_at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })
      : 'Unknown time',
    corr: e.correlation_id ? `cr-${e.correlation_id.slice(0, 4)}` : 'No correlation ID',
    fullCorr: e.correlation_id || '',
    target: e.target_ref || 'No target recorded',
    entryHash: e.entry_hash
      ? `${e.entry_hash.slice(0, 4)}…${e.entry_hash.slice(-3)}`
      : 'Unavailable',
    fullEntryHash: e.entry_hash || '',
    prevHash: e.prev_entry_hash
      ? `${e.prev_entry_hash.slice(0, 4)}…${e.prev_entry_hash.slice(-3)}`
      : 'Genesis or unavailable',
    fullPrevHash: e.prev_entry_hash || '',
    result: e.result || 'unknown',
    detail: e.detail,
    dot: e.result === 'success' ? '#0FB5A5' : e.result === 'failure' ? '#D9534F' : '#64748B',
    actorStyle:
      e.actor_type === 'agent'
        ? 'bg-[#e6f7f5] text-[#0a8d80]'
        : e.actor_type === 'human'
          ? 'bg-[#EEF0F7] text-[#4A5C95]'
          : 'bg-slate-100 text-slate-600',
    chainHead: e.sequence_no === 1,
  }));

  return (
    <div className="w-full min-w-0 space-y-4 animate-in fade-in-0 duration-200">
      <PageHeader
        title="Audit Ledger"
        module={moduleBarProps('ledger')}
        description="Recorded audit events for this tenant. Inspect each entry and verify the hash chain; an event alone does not establish that a complete approval or execution lifecycle occurred."
        meta={
          <>
            <span className="rounded bg-white/10 px-1.5 py-0.5 text-[10.5px] font-medium text-[#D6DBE8]">
              Autonomy L3 · append-only
            </span>
            {verification.status === 'intact' ? (
              <span className="inline-flex items-center gap-1 rounded border border-[#0FB5A5]/40 bg-[#0FB5A5]/20 px-1.5 py-0.5 text-[10.5px] font-semibold text-[#40D5C3]">
                ✓ Chain intact
              </span>
            ) : verification.status === 'broken' ? (
              <span className="inline-flex items-center gap-1 rounded border border-[#D9534F]/40 bg-[#D9534F]/20 px-1.5 py-0.5 text-[10.5px] font-semibold text-[#F0A59B]">
                ⚠ Chain break #{verification.firstBreak?.sequence_no}
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 rounded bg-white/10 px-1.5 py-0.5 text-[10.5px] font-semibold text-white">
                Chain verification unavailable
              </span>
            )}
          </>
        }
        actions={
          <>
            <LedgerRefresh
              runningCount={activeAgentRuns.length}
              initialRefreshedAt={new Date().toISOString()}
            />
            <VerifyButton tenantId={tenantId} />
          </>
        }
      />

      {/* Design System Sub-bar with Export Button */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white p-3.5 shadow-2xs">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-semibold text-slate-700">
            {verification.status === 'intact'
              ? 'Chain verified from genesis'
              : verification.status === 'broken'
                ? 'Chain verification failed'
                : 'Chain verification unavailable'}{' '}
            · {totalCount} recorded entries
          </span>
          <span className="text-slate-500 hidden md:inline">
            Append-only · hash-chained · INSERT-only enforced by DB role, not app code (ADR-5)
          </span>
        </div>

        <ExportLedgerButton tenantId={tenantId} tenantName={tenantName} tenantSlug={tenantSlug} />
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
