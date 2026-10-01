import Link from 'next/link';
import { ModuleContextFor } from '@/lib/module-context';
import { requireTenantContext } from '@/lib/tenant-context';

export const dynamic = 'force-dynamic';

function metric(value: number | null): string {
  return value === null ? 'Unavailable' : value.toLocaleString('en-IN');
}

export default async function DashboardPage() {
  const { supabase, tenantId, tenantName } = await requireTenantContext();
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

  const cards = [
    {
      label: 'Recorded open findings',
      value: openFindings,
      href: '/assessment',
      detail: 'Open, planned, or in remediation',
    },
    {
      label: 'Awaiting approval',
      value: pendingApprovals,
      href: '/approval',
      detail: 'Recorded actions awaiting human review',
    },
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

  return (
    <main className="mx-auto max-w-[1180px] space-y-6" aria-label="Tenant dashboard">
      <header className="rounded-2xl bg-[#1E2A4A] p-6 text-white">
        <p className="text-sm text-teal-300">Tenant dashboard</p>
        <h1 className="mt-1 font-heading text-2xl font-semibold">{tenantName}</h1>
        <p className="mt-2 max-w-2xl text-sm text-slate-200">
          Figures below reflect recorded tenant data. An unavailable value means the source could
          not be read; a zero means the query returned no matching records.
        </p>
        <ModuleContextFor module="dashboard" tone="dark" className="mt-3" />
        <div className="mt-5 rounded-xl border border-white/20 p-4">
          <p className="text-sm text-slate-200">Latest recorded engagement posture</p>
          <p className="mt-1 text-3xl font-semibold">
            {posture === null ? 'Unavailable' : `${posture}/100`}
          </p>
          <p className="mt-1 text-xs text-slate-300">
            {posture === null
              ? 'No verified posture score is available.'
              : 'Review the engagement for assessment scope and source.'}
          </p>
        </div>
      </header>

      <section
        aria-label="Recorded tenant metrics"
        className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
      >
        {cards.map((card) => (
          <Link
            key={card.label}
            href={card.href}
            className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm focus-visible:outline-2 focus-visible:outline-teal-500 hover:border-teal-500"
          >
            <h2 className="text-sm font-medium text-slate-600">{card.label}</h2>
            <p className="mt-2 text-3xl font-semibold text-[#1E2A4A]">{metric(card.value)}</p>
            <p className="mt-2 text-xs text-slate-500">{card.detail}</p>
          </Link>
        ))}
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-5" aria-label="Agent runs">
        <h2 className="font-heading text-lg font-semibold text-[#1E2A4A]">Recent agent runs</h2>
        {runs.error || !runs.data ? (
          <p className="mt-3 text-sm text-slate-600">Agent runs are unavailable.</p>
        ) : runs.data.length === 0 ? (
          <p className="mt-3 text-sm text-slate-600">No agent runs recorded for this tenant.</p>
        ) : (
          <ul className="mt-3 divide-y divide-slate-100">
            {runs.data.map((run) => (
              <li key={run.id} className="flex flex-wrap justify-between gap-2 py-2 text-sm">
                <span className="font-medium">{run.agent}</span>
                <span>{run.status}</span>
                <time dateTime={run.started_at} className="text-slate-500">
                  {run.started_at}
                </time>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
