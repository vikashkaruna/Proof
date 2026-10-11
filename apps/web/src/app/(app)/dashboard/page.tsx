import Link from 'next/link';
import { capabilitiesFor, type UserRole } from '@axiom/types';
import { DataPlaceholder, PageHeader, formatDateTime } from '@axiom/ui';
import { moduleBarProps } from '@/lib/module-bar';
import { requireTenantContext } from '@/lib/tenant-context';
import { visibleRoutes } from '../nav';

export const dynamic = 'force-dynamic';

function metric(value: number | null): string {
  return value === null ? 'Unavailable' : value.toLocaleString('en-IN');
}

export default async function DashboardPage() {
  const { supabase, tenantId, tenantName, role } = await requireTenantContext();
  // A tile links only to a screen this persona is offered; otherwise it is a
  // figure, not a door that redirects them to "forbidden".
  const reachable = new Set(visibleRoutes(role ? capabilitiesFor(role as UserRole) : []));
  const [ledger, evidence, dsars, consents, findings, actions, engagement, runs] =
    await Promise.all([
      supabase
        .from('audit_ledger')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', tenantId),
      supabase
        .from('evidence')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', tenantId),
      supabase.from('dsars').select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId),
      supabase
        .from('consent_records')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', tenantId),
      supabase.from('findings').select('id, status').eq('tenant_id', tenantId),
      supabase.from('remediation_actions').select('id, approval_status').eq('tenant_id', tenantId),
      supabase
        .from('engagements')
        .select('posture_score')
        .eq('tenant_id', tenantId)
        .order('started_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabase
        .from('agent_runs')
        .select('id, agent, status, started_at')
        .eq('tenant_id', tenantId)
        .order('started_at', { ascending: false })
        .limit(5),
    ]);

  const openFindings =
    findings.error || !findings.data
      ? null
      : findings.data.filter((row) => ['open', 'planned', 'in_remediation'].includes(row.status))
          .length;
  const pendingApprovals =
    actions.error || !actions.data
      ? null
      : actions.data.filter((row) => row.approval_status === 'awaiting_approval').length;
  const rawPosture = engagement.error ? null : engagement.data?.posture_score;
  const normalizedPosture =
    rawPosture == null
      ? null
      : Number(rawPosture) <= 1
        ? Number(rawPosture) * 100
        : Number(rawPosture);
  const posture =
    normalizedPosture !== null &&
    Number.isFinite(normalizedPosture) &&
    normalizedPosture >= 0 &&
    normalizedPosture <= 100
      ? Math.round(normalizedPosture)
      : null;

  // Open findings and pending approvals lead in the header band; the tiles
  // below are the records behind them.
  const cards = [
    {
      label: 'Evidence records',
      value: evidence.error ? null : evidence.count,
      href: '/evidence',
      detail: 'Storage assurance is shown per record',
    },
    {
      label: 'DSAR records',
      value: dsars.error ? null : dsars.count,
      href: '/dsars',
      detail: 'Inspect each request for status and deadline',
    },
    {
      label: 'Consent records',
      value: consents.error ? null : consents.count,
      href: '/consent',
      detail: 'Recorded grants and withdrawals; validity is record-specific',
    },
    {
      label: 'Ledger entries',
      value: ledger.error ? null : ledger.count,
      href: '/ledger',
      detail: 'Verify chain integrity in the ledger',
    },
  ];

  const headline = [
    {
      label: 'Latest recorded posture',
      value: posture === null ? 'Unavailable' : `${posture}/100`,
      note:
        posture === null
          ? 'No verified posture score is available.'
          : 'Review the engagement for assessment scope and source.',
    },
    {
      label: 'Open findings',
      value: metric(openFindings),
      note: 'Open, planned or in remediation',
    },
    {
      label: 'Awaiting approval',
      value: metric(pendingApprovals),
      note: 'Actions need a recorded human decision',
    },
  ];

  return (
    <section className="w-full min-w-0 space-y-4" aria-label="Dashboard">
      <PageHeader
        title="Dashboard"
        module={moduleBarProps('dashboard')}
        description={
          <>
            Recorded compliance state for{' '}
            <strong className="font-semibold text-white">{tenantName}</strong>. An unavailable value
            means the source could not be read; a zero means no matching records.
          </>
        }
      >
        <dl className="grid gap-2 sm:grid-cols-3">
          {headline.map((item) => (
            <div
              key={item.label}
              className="rounded-lg border border-white/15 bg-white/5 px-4 py-3"
            >
              <dt className="text-[11px] font-medium uppercase tracking-wide text-[#A6B0CC]">
                {item.label}
              </dt>
              <dd className="mt-0.5 font-heading text-2xl font-semibold text-white">
                {item.value}
              </dd>
              <dd className="text-[11.5px] text-[#D6DBE8]">{item.note}</dd>
            </div>
          ))}
        </dl>
      </PageHeader>

      <section
        aria-label="Recorded tenant metrics"
        className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"
      >
        {cards
          .filter((card) => reachable.has(card.href))
          .map((card) => {
            const href = card.href;
            const body = (
              <>
                <h2 className="text-[13px] font-medium text-slate-500">{card.label}</h2>
                <p className="mt-1 font-heading text-[28px] font-semibold leading-tight text-[#1E2A4A]">
                  {metric(card.value)}
                </p>
                <p className="mt-1 text-xs text-slate-500">{card.detail}</p>
              </>
            );
            return (
              <Link
                key={card.label}
                href={href}
                className="group relative rounded-xl border border-slate-200 bg-white px-5 py-4 shadow-xs transition-colors hover:border-[#0FB5A5] focus-visible:outline-2 focus-visible:outline-teal-500"
              >
                {body}
                <span
                  aria-hidden
                  className="absolute right-4 top-4 text-slate-300 transition-colors group-hover:text-[#0FB5A5]"
                >
                  →
                </span>
              </Link>
            );
          })}
      </section>

      <section
        className="rounded-xl border border-slate-200 bg-white px-5 py-4"
        aria-label="Agent runs"
      >
        <h2 className="font-heading text-base font-semibold text-[#1E2A4A]">Recent agent runs</h2>
        {runs.error || !runs.data ? (
          <p className="mt-3 text-sm text-slate-600">Agent runs are unavailable.</p>
        ) : runs.data.length === 0 ? (
          <DataPlaceholder className="mt-3" title="No agent runs recorded for this tenant." />
        ) : (
          <ul className="mt-2 divide-y divide-slate-100">
            {runs.data.map((run) => (
              <li
                key={run.id}
                className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm"
              >
                <span className="font-medium capitalize text-[#1E2A4A]">{run.agent}</span>
                <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
                  {run.status}
                </span>
                <time dateTime={run.started_at} className="text-xs text-slate-500">
                  {formatDateTime(run.started_at)}
                </time>
              </li>
            ))}
          </ul>
        )}
      </section>
    </section>
  );
}
