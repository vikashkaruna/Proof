import Link from 'next/link';
import { ACTIVE_RUN_STALE_MS, Capability, can, capabilitiesFor, type UserRole } from '@axiom/types';
import { DataPlaceholder, PageHeader, formatDateTime } from '@axiom/ui';
import { moduleBarProps } from '@/lib/module-bar';
import { requireTenantContext } from '@/lib/tenant-context';
import { visibleRoutes } from '../nav';

export const dynamic = 'force-dynamic';

function metric(value: number | null): string {
  return value === null ? 'Unavailable' : value.toLocaleString('en-IN');
}

// Server-side request clock, read once with the dashboard's other source data.
async function readDashboardClock(): Promise<number> {
  return Date.now();
}

export default async function DashboardPage() {
  const { supabase, tenantId, tenantName, role } = await requireTenantContext();
  // A tile links only to a screen this persona is offered; otherwise it is a
  // figure, not a door that redirects them to "forbidden".
  const reachable = new Set(visibleRoutes(role ? capabilitiesFor(role as UserRole) : []));
  const canManageEstate = can(Capability.ESTATE_MANAGE, { role });
  const canRunAssessment =
    can(Capability.AGENT_INVOKE, { role }) && can(Capability.ASSESSMENT_RUN, { role });
  // Match ReportsPage's preparation gate, rather than treating read access or
  // REPORT_GENERATE (which other workflows use) as preparation authority.
  const canPrepareReports = can(Capability.EVIDENCE_RECORD, { role });
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
        .select('id, title, status, posture_score, started_at')
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

  const evaluatedAt = await readDashboardClock();

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
      detail: can(Capability.LEDGER_VERIFY, { role })
        ? 'Verify chain integrity in the ledger'
        : 'Read the recorded audit trail and verification status',
    },
  ];

  const headline = [
    {
      label: 'Latest recorded posture',
      value: posture === null ? 'Unavailable' : `${posture}/100`,
      postureScore: true,
      note:
        posture === null
          ? 'No verified posture score is available.'
          : 'Recorded engagement score; finalized source provenance is unverified here. Not a compliance certification.',
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

  const journey = [
    {
      href: '/estate',
      title: canManageEstate ? '1. Set up the estate' : '1. Inspect the estate',
      detail: canManageEstate
        ? 'Identify systems and data sources before discovery.'
        : 'Read the registered systems and their recorded data sources.',
    },
    {
      href: '/assessment',
      title: canRunAssessment ? '2. Assess the gaps' : '2. Inspect the assessment',
      detail: canRunAssessment
        ? 'Prepare an assessment request and follow its recorded results and finalization.'
        : 'Read control results and the recorded assessment status.',
    },
    {
      href: '/plans',
      title: '3. Review the plan',
      detail: can(Capability.PLAN_APPROVE, { role })
        ? 'Inspect each action, recorded dry run and rollback before a decision.'
        : 'Read each action and its recorded dry-run and rollback details.',
    },
    {
      href: '/approval',
      title: '4. Decide on actions',
      detail: 'Approve or reject only the actions within your assigned scope.',
    },
    {
      href: '/execution',
      title: '5. Follow execution',
      detail: 'Inspect execution results and rollback records after approval.',
    },
    {
      href: '/reports',
      title: '6. Review reports',
      detail: canPrepareReports
        ? 'Prepare working reports and follow their recorded review and release status.'
        : 'Read working reports and their recorded review and release status.',
    },
    {
      href: '/evidence',
      title: 'Inspect supporting evidence',
      detail: 'Read the retained records and their individual storage assurance.',
    },
    {
      href: '/ledger',
      title: 'Trace recorded decisions',
      detail: 'Follow the audit trail for assessment, approval and execution.',
    },
  ].filter((step) => reachable.has(step.href));

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
              <dd className="mt-0.5 flex items-center gap-2">
                <span
                  className="font-heading text-2xl font-semibold text-white"
                  data-testid={'postureScore' in item ? 'posture-score' : undefined}
                >
                  {'postureScore' in item && posture !== null ? (
                    <>
                      {/* A recorded score has no strength band without verified source provenance. */}
                      <span className="text-white" data-testid="posture-value">
                        {posture}
                      </span>
                      <span className="text-[0.5em] font-medium">/100</span>
                    </>
                  ) : (
                    item.value
                  )}
                </span>
                {'postureScore' in item && posture !== null && (
                  <span
                    className="rounded-full bg-white/10 px-2 py-0.5 text-[11px] font-semibold text-white ring-1 ring-inset ring-white/20"
                    data-testid="posture-provenance"
                  >
                    Unverified
                  </span>
                )}
              </dd>
              <dd className="text-[11.5px] text-[#D6DBE8]">{item.note}</dd>
            </div>
          ))}
        </dl>
      </PageHeader>

      <section
        aria-label="Your workflow"
        className="rounded-xl border border-slate-200 bg-white p-5"
      >
        <h2 className="font-heading text-base font-semibold text-[#1E2A4A]">
          Available workflow steps
        </h2>
        <p className="mt-1 text-sm text-slate-600">
          Follow the work from setup to released reports. These shortcuts reflect your role; each
          screen shows the recorded state and any prerequisites still needed. Numbers mark the
          shared workflow order; steps outside your role are omitted.
        </p>
        <ol className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          {journey.map((step) => (
            <li key={step.href}>
              <Link
                href={step.href}
                className="block h-full rounded-lg border border-slate-200 p-3 transition-colors hover:border-teal-500 focus-visible:outline-2 focus-visible:outline-teal-500"
              >
                <span className="text-sm font-semibold text-[#1E2A4A]">{step.title} →</span>
                <span className="mt-1 block text-xs leading-relaxed text-slate-600">
                  {step.detail}
                </span>
              </Link>
            </li>
          ))}
        </ol>
      </section>

      {reachable.has('/engagements') && (
        <section
          aria-label="Latest assessment"
          className="rounded-xl border border-slate-200 bg-white p-5"
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="font-heading text-base font-semibold text-[#1E2A4A]">
              Latest assessment
            </h2>
            <Link
              href="/engagements"
              className="text-sm font-medium text-teal-800 underline underline-offset-4"
            >
              All engagements
            </Link>
          </div>
          {engagement.error ? (
            <p className="mt-3 text-sm text-slate-600">Assessment records are unavailable.</p>
          ) : !engagement.data?.id ? (
            <p className="mt-3 text-sm text-slate-600">
              No assessment recorded yet. Open engagements to start or review an assessment.
            </p>
          ) : (
            <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="font-medium text-slate-900">{engagement.data.title}</p>
                <p className="mt-1 text-sm text-slate-600">
                  Recorded status: {engagement.data.status.replace(/_/g, ' ')}
                </p>
                <p className="mt-1 text-xs text-slate-500">
                  Started {formatDateTime(engagement.data.started_at)}
                </p>
              </div>
              <Link
                href={`/engagements/${engagement.data.id}`}
                className="rounded-md border border-slate-300 px-3 py-2 text-sm font-medium text-[#1E2A4A] hover:bg-slate-50"
              >
                Open assessment
              </Link>
            </div>
          )}
        </section>
      )}

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
            {runs.data.map((run) => {
              const active = ['running', 'queued'].includes(run.status);
              const started = Date.parse(run.started_at);
              const unknown = active && (!Number.isFinite(started) || started > evaluatedAt);
              const stalled = active && !unknown && started < evaluatedAt - ACTIVE_RUN_STALE_MS;
              return (
                <li
                  key={run.id}
                  className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm"
                >
                  <span className="font-medium capitalize text-[#1E2A4A]">{run.agent}</span>
                  <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
                    {stalled ? 'Stalled' : unknown ? 'Activity unverified' : run.status}
                  </span>
                  <time dateTime={run.started_at} className="text-xs text-slate-500">
                    {formatDateTime(run.started_at)}
                  </time>
                  {(stalled || unknown) && (
                    <p className="w-full text-xs text-slate-600">
                      Recorded {run.status};{' '}
                      {stalled
                        ? 'no completion recorded within the one-hour activity window. Check the run before treating it as active.'
                        : 'the start timestamp cannot establish current activity.'}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </section>
  );
}
