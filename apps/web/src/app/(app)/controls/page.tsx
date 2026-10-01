import { Card, CardContent, Badge, SeverityChip } from '@axiom/ui';
import { controls as controlLib, LIBRARY_VERSION } from '@axiom/control-library';
import { GenericModuleView } from '../generic-module-view';

export const dynamic = 'force-dynamic';

export default async function ControlLibraryPage({
  searchParams,
}: {
  searchParams: Promise<{ domain?: string; severity?: string; q?: string }>;
}) {
  const resolvedSearchParams = await searchParams;
  // The catalogue is the explicitly versioned, immutable package release. It
  // does not represent tenant findings or a silently substituted DB result.
  const allControls = controlLib;

  // Count by obligation / domain
  const noticeCount = allControls.filter(
    (c) =>
      c.domain?.toLowerCase().includes('consent') ||
      c.domain?.toLowerCase().includes('notice') ||
      c.title?.toLowerCase().includes('notice') ||
      c.title?.toLowerCase().includes('consent'),
  ).length;

  const rightsCount = allControls.filter(
    (c) =>
      c.domain?.toLowerCase().includes('principal') ||
      c.domain?.toLowerCase().includes('rights') ||
      c.domain?.toLowerCase().includes('erasure') ||
      c.domain?.toLowerCase().includes('dsar'),
  ).length;

  const securityCount = allControls.filter(
    (c) =>
      c.domain?.toLowerCase().includes('security') ||
      c.domain?.toLowerCase().includes('breach') ||
      c.domain?.toLowerCase().includes('technical'),
  ).length;

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
        c.id.toLowerCase().includes(q) ||
        c.title.toLowerCase().includes(q) ||
        c.obligation.toLowerCase().includes(q),
    );
  }

  const domains = Array.from(
    new Set(allControls.map((c) => c.domain).filter(Boolean)),
  ).sort() as string[];
  const severities = ['critical', 'high', 'medium', 'low'] as const;

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
        desc: `Packaged control library version ${LIBRARY_VERSION}: ${allControls.length} controls. This catalogue is not a tenant assessment; review the saved engagement before running Parikshan.`,
        actionLabel: 'Open saved assessment',
        actionHref: '/assessment',
        cards: [
          {
            h: 'Coverage',
            rows: [
              { t: 'Total controls', v: String(allControls.length), dot: '#1E2A4A' },
              {
                t: 'Library version',
                v: LIBRARY_VERSION,
                dot: '#0FB5A5',
              },
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
            const citationsList = c.citations
              .map((cit) => `${cit.instrument} ${cit.reference}`)
              .join('; ');
            const maxPenaltyINR = c.scoring.maxPenaltyINR;
            const penaltyPts = c.scoring.penaltyPoints;

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
