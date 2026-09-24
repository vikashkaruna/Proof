import { requireTenantContext } from '@/lib/tenant-context';
import { Card, CardContent, Badge, SeverityChip } from '@axiom/ui';
import { controls as controlLib, CONTROL_LIBRARY_COUNT } from '@axiom/control-library';
import { GenericModuleView, type ModuleTelemetryEvent } from '../generic-module-view';

export const dynamic = 'force-dynamic';

export default async function ControlLibraryPage({
  searchParams,
}: {
  searchParams: Promise<{ domain?: string; severity?: string; q?: string }>;
}) {
  const resolvedSearchParams = await searchParams;
  // SEC-3: was `createSupabaseAdmin()`. The service-role key bypasses RLS
  // by design, and these queries carried no tenant filter, so any
  // authenticated user saw every tenant's data. The client below is
  // user-scoped: RLS applies, and the explicit filters state the intent.
  const { supabase, tenantId } = await requireTenantContext();
  let dbControls: any[] = [];
  let recentRuns: any[] = [];

  try {
    const [ctrlRes, ledgerRes] = await Promise.all([
      supabase.from('controls').select('*'),
      supabase
        .from('audit_ledger')
        .select('seq, actor, action, target_ref, timestamp, entry_hash, result')
        .eq('tenant_id', tenantId)
        .eq('actor_id', 'parikshan')
        .order('sequence_no', { ascending: false })
        .limit(4),
    ]);
    if (ctrlRes.data && ctrlRes.data.length > 0) {
      dbControls = ctrlRes.data;
    }
    if (ledgerRes.data) {
      recentRuns = ledgerRes.data;
    }
  } catch {
    // Fallback if db offline
  }

  // Use database controls or static control-library
  const allControls = dbControls.length > 0 ? dbControls : controlLib;
  const libVersion = allControls[0]?.introducedInVersion || allControls[0]?.version || 'v25.11.2';

  // Count by obligation / domain
  const noticeCount =
    allControls.filter(
      (c) =>
        c.domain?.toLowerCase().includes('consent') ||
        c.domain?.toLowerCase().includes('notice') ||
        c.title?.toLowerCase().includes('notice') ||
        c.title?.toLowerCase().includes('consent'),
    ).length || 9;

  const rightsCount =
    allControls.filter(
      (c) =>
        c.domain?.toLowerCase().includes('principal') ||
        c.domain?.toLowerCase().includes('rights') ||
        c.domain?.toLowerCase().includes('erasure') ||
        c.domain?.toLowerCase().includes('dsar'),
    ).length || 7;

  const securityCount =
    allControls.filter(
      (c) =>
        c.domain?.toLowerCase().includes('security') ||
        c.domain?.toLowerCase().includes('breach') ||
        c.domain?.toLowerCase().includes('technical'),
    ).length || 11;

  let filtered = allControls;
  if (resolvedSearchParams.domain) {
    filtered = filtered.filter((c) => c.domain === resolvedSearchParams.domain);
  }
  if (resolvedSearchParams.severity) {
    filtered = filtered.filter((c) => c.severity === resolvedSearchParams.severity);
  }
  if (resolvedSearchParams.q) {
    const q = resolvedSearchParams.q.toLowerCase();
    filtered = filtered.filter(
      (c) =>
        c.id?.toLowerCase().includes(q) ||
        c.title?.toLowerCase().includes(q) ||
        c.obligation?.toLowerCase().includes(q),
    );
  }

  const domains = Array.from(
    new Set(allControls.map((c) => c.domain).filter(Boolean)),
  ).sort() as string[];
  const severities = ['critical', 'high', 'medium', 'low'] as const;

  const telemetryEvents: ModuleTelemetryEvent[] = recentRuns.map((r) => ({
    seq: r.seq,
    title: r.action || 'Parikshan Control Verification Check',
    detail: `Control Target: ${r.target_ref || 'Full Statutory Library'} · Actor: parikshan`,
    time: r.timestamp ? new Date(r.timestamp).toLocaleTimeString('en-IN') : 'Recently',
    target: r.target_ref || 'Control Library',
    hash: r.entry_hash,
    status: r.result === 'success' ? '✓ passed' : r.result,
  }));

  return (
    <GenericModuleView
      meta={{
        title: 'Control Library',
        hi: 'नियंत्रण संग्रह',
        phase: 'P0',
        agent: 'Parikshan',
        agentKey: 'parikshan',
        autonomy: '—',
        moduleId: 'M0.2',
        statutoryCitation: 'DPDPA 2023 §4-§16 & Rules 2025',
        desc: `Versioned catalogue of ~${allControls.length || CONTROL_LIBRARY_COUNT} discrete, testable controls, each mapped to a DPDP Act section / Rule citation, required evidence type and remediation pattern. Multi-framework overlays from Phase 4.`,
        actionLabel: 'Execute Parikshan Audit Run ⚡',
        cards: [
          {
            h: 'Coverage',
            rows: [
              { t: 'Total controls', v: String(allControls.length || 43), dot: '#1E2A4A' },
              {
                t: 'Library version',
                v: String(libVersion).startsWith('v') ? String(libVersion) : `v${libVersion}`,
                dot: '#0FB5A5',
              },
              { t: 'Multi-framework overlays', v: 'P4 (ISO/SOC2)', dot: '#C9A227' },
            ],
          },
          {
            h: 'By obligation',
            rows: [
              { t: 'Notice & consent', v: String(noticeCount), dot: '#1E2A4A' },
              { t: 'Rights of principals', v: String(rightsCount), dot: '#1E2A4A' },
              { t: 'Security safeguards', v: String(securityCount), dot: '#1E2A4A' },
            ],
          },
        ],
        recentEvents: telemetryEvents,
        telemetryTitle: 'Parikshan Audit Evaluations & Evidence Mappings',
      }}
    >
      <div className="flex flex-col gap-4">
        {/* Filters bar */}
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white p-3 shadow-2xs">
          <form action="/controls" method="GET" className="flex flex-wrap items-center gap-2.5">
            <input
              type="text"
              name="q"
              defaultValue={resolvedSearchParams.q ?? ''}
              placeholder="Search controls, IDs, text..."
              className="h-9 w-64 rounded-md border border-slate-300 bg-white px-3 text-xs placeholder:text-slate-400 focus:border-teal-500 focus:outline-none"
            />
            <select
              name="domain"
              defaultValue={resolvedSearchParams.domain ?? ''}
              className="h-9 rounded-md border border-slate-300 bg-white px-2.5 text-xs text-slate-700 focus:border-teal-500 focus:outline-none"
            >
              <option value="">All domains ({domains.length})</option>
              {domains.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
            <select
              name="severity"
              defaultValue={resolvedSearchParams.severity ?? ''}
              className="h-9 rounded-md border border-slate-300 bg-white px-2.5 text-xs text-slate-700 focus:border-teal-500 focus:outline-none"
            >
              <option value="">All severities</option>
              {severities.map((s) => (
                <option key={s} value={s}>
                  {s.toUpperCase()}
                </option>
              ))}
            </select>
            <button
              type="submit"
              className="h-9 rounded-md bg-[#1E2A4A] px-4 text-xs font-semibold text-white hover:bg-[#283863] transition-colors"
            >
              Filter
            </button>
            {(resolvedSearchParams.domain ||
              resolvedSearchParams.severity ||
              resolvedSearchParams.q) && (
              <a
                href="/controls"
                className="h-9 inline-flex items-center px-2.5 text-xs text-slate-500 hover:text-slate-800"
              >
                Clear
              </a>
            )}
          </form>
          <div className="text-xs text-slate-500 font-mono">
            Showing <strong>{filtered.length}</strong> of {allControls.length} controls
          </div>
        </div>

        {/* Controls catalogue cards */}
        <div className="grid grid-cols-1 gap-3">
          {filtered.map((c) => {
            const citationsList = Array.isArray(c.citations)
              ? c.citations
                  .map((cit: any) => `${cit.instrument || 'DPDPA'} ${cit.reference || ''}`)
                  .join('; ')
              : c.citations || 'DPDPA 2023';
            const maxPenaltyINR = c.scoring?.maxPenaltyINR ?? 2500000000;
            const penaltyPts = c.scoring?.penaltyPoints ?? 25;

            return (
              <Card key={c.id} className="transition-all hover:border-slate-300 hover:shadow-xs">
                <CardContent className="p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex flex-col gap-1.5 flex-1 min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <code className="rounded bg-mist-100 px-1.5 py-0.5 font-mono text-xs font-semibold text-indigo-700">
                          {c.id}
                        </code>
                        <Badge variant="indigo">{c.domain}</Badge>
                        <SeverityChip severity={c.severity} />
                        {c.sdfOnly && <Badge variant="warning">SDF only</Badge>}
                        {c.childrenOnly && <Badge variant="warning">Children</Badge>}
                      </div>
                      <h3 className="font-heading text-base font-semibold text-indigo-700">
                        {c.title}
                      </h3>
                      <p className="text-sm text-slate-600 leading-relaxed">{c.obligation}</p>
                      <p className="text-xs text-slate-500 font-mono">Citations: {citationsList}</p>
                    </div>
                    <div className="text-right text-xs text-slate-500 shrink-0 border-l border-slate-100 pl-4">
                      <p className="font-semibold text-slate-700">
                        Max penalty: ₹{(maxPenaltyINR / 10000000).toFixed(0)} Cr
                      </p>
                      <p className="font-mono text-[11px] text-amber-700 mt-0.5">
                        Risk pts: {penaltyPts}
                      </p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      </div>
    </GenericModuleView>
  );
}
