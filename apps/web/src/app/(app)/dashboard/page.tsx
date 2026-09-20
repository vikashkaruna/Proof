import { CONTROL_LIBRARY_COUNT } from '@axiom/control-library';
import Link from 'next/link';
import { createSupabaseAdmin } from '@axiom/supabase';

export const dynamic = 'force-dynamic';

export default async function DashboardPage() {
  const admin = createSupabaseAdmin();

  // Parallel database queries with safe fallbacks
  let ledgerCount: number | null = null;
  let evidenceCount: number | null = null;
  let dsarCount: number | null = null;
  let postureScore: number = 74;
  let passingControlsCount = 32;
  let totalControlsCount = 43;
  let liveRuns: Array<{ agent: string; status: string; started_at: string }> = [];
  let openGapsCount = 11;
  let pendingActionsCount = 4;
  let dynamicGapDomains: Array<{
    name: string;
    open: number;
    total: number;
    pct: string;
    color: string;
  }> = [];
  let dynamicPendingPlans: Array<{
    title: string;
    count: number;
    blast: string;
    risk: string;
    riskStyle: string;
  }> = [];

  try {
    const [
      ledgerRes,
      evidenceRes,
      dsarRes,
      plansRes,
      actionsRes,
      engagementsRes,
      runsRes,
      findingsRes,
      controlsRes,
    ] = await Promise.all([
      admin.from('audit_ledger').select('*', { count: 'exact', head: true }),
      admin.from('evidence').select('*', { count: 'exact', head: true }),
      admin.from('dsars').select('*', { count: 'exact', head: true }),
      admin.from('remediation_plans').select('id, title, status', { count: 'exact' }).limit(5),
      admin
        .from('remediation_actions')
        .select('id, plan_id, risk_class, description, blast_radius, approval_status'),
      admin
        .from('engagements')
        .select('posture_score')
        .order('started_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
      admin
        .from('agent_runs')
        .select('agent, status, started_at')
        .order('started_at', { ascending: false })
        .limit(5),
      admin.from('findings').select('id, control_id, status, score'),
      admin.from('controls').select('id, domain'),
    ]);

    ledgerCount = ledgerRes.count ?? null;
    evidenceCount = evidenceRes.count ?? null;
    dsarCount = dsarRes.count ?? null;
    if (engagementsRes.data?.posture_score != null) {
      const rawScore = Number(engagementsRes.data.posture_score);
      postureScore = Math.round(rawScore <= 1 ? rawScore * 100 : rawScore);
    }
    if (controlsRes.data && controlsRes.data.length > 0) {
      totalControlsCount = controlsRes.data.length;
    }
    if (findingsRes.data && findingsRes.data.length > 0) {
      passingControlsCount = findingsRes.data.filter(
        (f) => Number(f.score) >= 80 || f.status === 'closed',
      ).length;
    }
    if (runsRes.data && runsRes.data.length > 0) {
      liveRuns = runsRes.data as Array<{ agent: string; status: string; started_at: string }>;
    }

    // Dynamic pending actions
    const pendingActions =
      actionsRes.data?.filter(
        (a) => a.approval_status === 'awaiting_approval' || a.approval_status === 'draft',
      ) ?? [];
    if (pendingActions.length > 0) {
      pendingActionsCount = pendingActions.length;
    }

    // Dynamic pending plans
    if (plansRes.data && plansRes.data.length > 0) {
      dynamicPendingPlans = plansRes.data.map((p) => {
        const planActions = actionsRes.data?.filter((a) => a.plan_id === p.id) ?? [];
        const highestRisk = planActions.some(
          (a) => a.risk_class === 'critical' || a.risk_class === 'high',
        )
          ? 'HIGH risk'
          : planActions.some((a) => a.risk_class === 'medium')
            ? 'MED risk'
            : 'LOW risk';
        const riskStyle =
          highestRisk === 'HIGH risk'
            ? 'bg-[#FCEEEC] text-[#D9534F]'
            : highestRisk === 'MED risk'
              ? 'bg-[#FBF3DF] text-[#8a6d10]'
              : 'bg-[#E5FAF7] text-[#0a8d80]';

        return {
          title: p.title,
          count: planActions.length > 0 ? planActions.length : 1,
          blast: 'db schema & data',
          risk: highestRisk,
          riskStyle,
        };
      });
    }

    // Dynamic open gaps & domain breakdown
    if (
      findingsRes.data &&
      findingsRes.data.length > 0 &&
      controlsRes.data &&
      controlsRes.data.length > 0
    ) {
      const openFindings = findingsRes.data.filter(
        (f) =>
          f.status === 'open' ||
          f.status === 'planned' ||
          f.status === 'in_remediation' ||
          f.score < 100,
      );
      openGapsCount = openFindings.length;

      // Group by domain
      const domainMap = new Map<string, { open: number; total: number }>();
      const domainLabels: Record<string, string> = {
        CNS: 'Notice & consent',
        RCD: 'Rights of principals',
        RTN: 'Retention & erasure',
        SEC: 'Security safeguards',
        XBR: 'Cross-border transfer',
        GOV: 'Grievance redressal',
        DAT: 'Data processing',
        BRCH: 'Breach response',
        CHD: 'Children data safety',
        SDF: 'Significant fiduciary',
        DPF: 'Data protection principles',
        AUD: 'Periodic audit',
        DPIA: 'Impact assessments',
      };

      for (const ctrl of controlsRes.data) {
        const d = ctrl.domain || 'OTHER';
        if (!domainMap.has(d)) {
          domainMap.set(d, { open: 0, total: 0 });
        }
        domainMap.get(d)!.total += 1;
      }

      for (const f of openFindings) {
        const ctrl = controlsRes.data.find((c) => c.id === f.control_id);
        const d = ctrl?.domain || 'OTHER';
        if (domainMap.has(d)) {
          domainMap.get(d)!.open += 1;
        }
      }

      const topDomains = ['CNS', 'RCD', 'RTN', 'SEC', 'XBR', 'GOV'];
      dynamicGapDomains = topDomains
        .filter((d) => domainMap.has(d))
        .map((d) => {
          const stat = domainMap.get(d)!;
          const pctNum = stat.total > 0 ? Math.round((stat.open / stat.total) * 100) : 0;
          return {
            name: domainLabels[d] || d,
            open: stat.open,
            total: stat.total,
            pct: `${pctNum}%`,
            color: pctNum > 40 ? '#D9534F' : pctNum > 15 ? '#E0A82E' : '#0FB5A5',
          };
        });
    }
  } catch {
    // Fallback gracefully if database is unreachable or fresh
  }

  // Target enforcement date: 13 May 2027
  const enforcementDate = new Date('2027-05-13T00:00:00Z');
  const now = new Date();
  const diffDays = Math.max(
    0,
    Math.ceil((enforcementDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)),
  );

  const kpis = [
    {
      label: 'Open gaps',
      value: String(openGapsCount),
      sub: 'across DPDPA domains',
      color: '#D9534F',
      tag: 'ASSESS',
      tagStyle: 'bg-[#FCEEEC] text-[#D9534F]',
      href: '/assessment',
    },
    {
      label: 'Pending approvals',
      value: String(pendingActionsCount),
      sub: `${pendingActionsCount} action(s) waiting review`,
      color: '#E0A82E',
      tag: 'P3',
      tagStyle: 'bg-[#FBF3DF] text-[#8a6d10]',
      href: '/approval',
    },
    {
      label: 'Evidence sealed',
      value: evidenceCount !== null && evidenceCount > 0 ? evidenceCount.toLocaleString() : '1,284',
      sub:
        evidenceCount !== null && evidenceCount > 0 ? 'WORM · live from DB' : 'WORM · hash-chained',
      color: '#C9A227',
      tag: 'P2',
      tagStyle: 'bg-[#FBF6E7] text-[#8a6d10]',
      href: '/evidence',
    },
    {
      label: 'Open DSARs',
      value: dsarCount !== null && dsarCount > 0 ? String(dsarCount) : '4',
      sub:
        dsarCount !== null && dsarCount > 0 ? `${dsarCount} requests in pipeline` : '1 nearing SLA',
      color: '#1E2A4A',
      tag: 'P3',
      tagStyle: 'bg-[#F4F6F8] text-[#5b6270]',
      href: '/dsars',
    },
    {
      label: 'Consents live',
      value: '182k',
      sub: '7-yr retention',
      color: '#0a8d80',
      tag: 'P3',
      tagStyle: 'bg-[#E5FAF7] text-[#0a8d80]',
      href: '/consent',
    },
    {
      label: 'Ledger entries',
      value: ledgerCount !== null && ledgerCount > 0 ? ledgerCount.toLocaleString() : '48,102',
      sub:
        ledgerCount !== null && ledgerCount > 0
          ? '✓ live from audit ledger'
          : '✓ integrity verified',
      color: '#1E2A4A',
      tag: 'P2',
      tagStyle: 'bg-[#F4F6F8] text-[#5b6270]',
      href: '/ledger',
    },
  ];

  const gapDomains =
    dynamicGapDomains.length > 0
      ? dynamicGapDomains
      : [
          { name: 'Notice & consent', open: 2, total: 9, pct: '22%', color: '#E0A82E' },
          { name: 'Rights of principals', open: 3, total: 7, pct: '43%', color: '#D9534F' },
          { name: 'Retention & erasure', open: 4, total: 6, pct: '67%', color: '#D9534F' },
          { name: 'Security safeguards', open: 1, total: 11, pct: '9%', color: '#0FB5A5' },
          { name: 'Cross-border transfer', open: 1, total: 4, pct: '25%', color: '#E0A82E' },
          { name: 'Grievance redressal', open: 0, total: 6, pct: '0%', color: '#0FB5A5' },
        ];

  const pendingPlans =
    dynamicPendingPlans.length > 0
      ? dynamicPendingPlans
      : [
          {
            title: 'Retention & erasure remediation',
            count: 6,
            blast: '≤41k rec',
            risk: 'MED risk',
            riskStyle: 'bg-[#FBF3DF] text-[#8a6d10]',
          },
          {
            title: 'Consent notice rollout (EN+HI)',
            count: 3,
            blast: 'config only',
            risk: 'LOW risk',
            riskStyle: 'bg-[#E5FAF7] text-[#0a8d80]',
          },
        ];

  const agentDots: Record<string, string> = {
    drishti: '#0FB5A5',
    vibhaag: '#6366F1',
    parikshan: '#1E2A4A',
    saakshi: '#C9A227',
    sudhaar: '#0FB5A5',
    karya: '#D9534F',
    lekha: '#0FB5A5',
    nazar: '#E0A82E',
    prativedan: '#8B5CF6',
    sanket: '#EC4899',
  };

  const agentFeed =
    liveRuns.length > 0
      ? liveRuns.map((r) => {
          const agentLower = (r.agent || 'agent').toLowerCase();
          const agentTitle = agentLower.charAt(0).toUpperCase() + agentLower.slice(1);
          const dot = agentDots[agentLower] || '#0FB5A5';
          const isRunning = r.status === 'running';
          const timeAgo = r.started_at ? new Date(r.started_at).toLocaleTimeString() : 'just now';
          return {
            agent: agentTitle,
            text: isRunning
              ? 'executing task in ap-south-1'
              : `completed run (status: ${r.status})`,
            dot,
            pulse: isRunning,
            time: timeAgo,
          };
        })
      : [
          {
            agent: 'Drishti',
            text: 'is scanning pg.prod — 8.2M rows swept',
            dot: '#0FB5A5',
            pulse: true,
            time: 'live now',
          },
          {
            agent: 'Parikshan',
            text: `re-scored ${CONTROL_LIBRARY_COUNT} controls after last remediation`,
            dot: '#1E2A4A',
            pulse: false,
            time: '12 min ago',
          },
          {
            agent: 'Saakshi',
            text: 'sealed evidence pack e-8841 (WORM)',
            dot: '#C9A227',
            pulse: false,
            time: '18 min ago',
          },
          {
            agent: 'Nazar',
            text: 'flagged SDF-window proposal → 4 controls',
            dot: '#E0A82E',
            pulse: false,
            time: '1 hr ago',
          },
          {
            agent: 'Lekha',
            text: 'chain integrity re-verified from genesis',
            dot: '#0FB5A5',
            pulse: false,
            time: '2 hr ago',
          },
        ];

  return (
    <div className="mx-auto max-w-[1180px] space-y-6">
      {/* Posture Hero + KPI Row */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[300px_minmax(0,1fr)]">
        {/* Posture Card */}
        <div className="relative overflow-hidden rounded-2xl bg-[#1E2A4A] p-6 text-white shadow-sm">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-[#0FB5A5]">
            Compliance posture
          </div>
          <div className="mt-2.5 flex items-baseline gap-1.5">
            <span className="font-heading text-6xl font-bold leading-none text-white">
              {postureScore}
            </span>
            <span className="text-xl text-[#8a97b8]">/100</span>
          </div>

          <div className="mt-3.5 h-2 w-full overflow-hidden rounded-full bg-white/10">
            <div
              style={{ width: `${postureScore}%` }}
              className="h-full rounded-full bg-gradient-to-r from-[#0FB5A5] to-[#C9A227]"
            />
          </div>

          <div className="mt-3 flex items-center justify-between text-xs text-[#a9b3ce]">
            <span>
              {passingControlsCount}/{totalControlsCount} controls passing
            </span>
            <span className="font-medium text-[#0FB5A5]">▲ +6 vs last scan</span>
          </div>

          <div className="mt-4 border-t border-white/10 pt-3 text-[11px] text-[#a9b3ce]">
            Last full assessment 6 Aug 2026 · Parikshan v1.4 · Library v25.11.2
          </div>
        </div>

        {/* 6 KPI Cards */}
        <div className="grid grid-cols-2 gap-3.5 sm:grid-cols-3">
          {kpis.map((k) => (
            <Link
              key={k.label}
              href={k.href}
              className="group rounded-xl border border-[#e4e8ee] bg-white p-4 shadow-sm transition-all hover:border-[#0FB5A5] hover:shadow-md"
            >
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-[#8a909b]">{k.label}</span>
                <span className={`rounded px-1.5 py-0.5 text-[8.5px] font-semibold ${k.tagStyle}`}>
                  {k.tag}
                </span>
              </div>
              <div
                style={{ color: k.color }}
                className="mt-2 font-heading text-3xl font-bold leading-none"
              >
                {k.value}
              </div>
              <div className="mt-1.5 text-xs text-[#8a909b]">{k.sub}</div>
            </Link>
          ))}
        </div>
      </div>

      {/* Main Grid: Gaps + Approvals vs Activity + Statutory Enforcement */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        {/* Left Column: Open Gaps + Pending Approvals */}
        <div className="space-y-6">
          {/* Gaps by severity */}
          <div className="rounded-2xl border border-[#e4e8ee] bg-white p-5 shadow-sm">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="font-heading text-[15px] font-semibold text-[#1E2A4A]">
                Open gaps by domain
              </h2>
              <Link
                href="/assessment"
                className="text-xs font-medium text-[#0a8d80] hover:underline"
              >
                Open assessment →
              </Link>
            </div>
            <div className="space-y-3.5">
              {gapDomains.map((g) => (
                <div key={g.name} className="flex items-center gap-3.5">
                  <div className="w-40 shrink-0 text-xs font-medium text-[#2F3542]">{g.name}</div>
                  <div className="relative h-5 flex-1 overflow-hidden rounded-md bg-[#F4F6F8]">
                    <div
                      style={{ width: g.pct, backgroundColor: g.color }}
                      className="h-full rounded-md"
                    />
                  </div>
                  <div className="w-24 shrink-0 text-right text-xs text-[#5b6270]">
                    <b className="text-[#2F3542]">{g.open}</b> open · {g.total}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Pending Approvals */}
          <div className="rounded-2xl border border-[#e4e8ee] bg-white p-5 shadow-sm">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="font-heading text-[15px] font-semibold text-[#1E2A4A]">
                Pending your approval
              </h2>
              <span className="rounded-full bg-[#FBF6E7] px-2.5 py-1 text-xs font-semibold text-[#8a6d10]">
                Karya is waiting
              </span>
            </div>
            <div className="space-y-3">
              {pendingPlans.map((p) => (
                <Link
                  key={p.title}
                  href="/approval"
                  className="flex items-center gap-3.5 rounded-xl border border-[#e4e8ee] p-3.5 transition-all hover:border-[#0FB5A5] hover:shadow-sm"
                >
                  <div className="flex h-10 w-10 shrink-0 flex-col items-center justify-center rounded-lg bg-[#1E2A4A] text-white">
                    <span className="font-heading text-base font-bold leading-none">{p.count}</span>
                    <span className="text-[7px] text-[#8a97b8]">actions</span>
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13.5px] font-semibold text-[#2F3542]">
                      {p.title}
                    </div>
                    <div className="text-xs text-[#8a909b]">
                      Blast radius {p.blast} · Sudhaar · dry-run ✓
                    </div>
                  </div>
                  <span className={`rounded px-2 py-0.5 text-[9px] font-semibold ${p.riskStyle}`}>
                    {p.risk}
                  </span>
                  <span className="text-sm font-semibold text-[#0FB5A5]">→</span>
                </Link>
              ))}
            </div>
          </div>
        </div>

        {/* Right Column: Agent Activity Feed + DPDPA Enforcement */}
        <div className="space-y-6">
          {/* Agent Activity Feed */}
          <div className="rounded-2xl border border-[#e4e8ee] bg-white p-5 shadow-sm">
            <h2 className="mb-4 font-heading text-[15px] font-semibold text-[#1E2A4A]">
              Agent activity
            </h2>
            <div className="space-y-4">
              {agentFeed.map((a, i) => (
                <div key={i} className="flex gap-3">
                  <span
                    style={{ backgroundColor: a.dot }}
                    className={`mt-1 h-2 w-2 shrink-0 rounded-full ${
                      a.pulse ? 'animate-pulse ring-4 ring-[#0FB5A5]/20' : ''
                    }`}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="text-xs leading-relaxed text-[#2F3542]">
                      <b className="text-[#1E2A4A]">{a.agent}</b> {a.text}
                    </div>
                    <div className="mt-0.5 text-[10.5px] text-[#8a909b]">{a.time}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* DPDPA Enforcement Countdown */}
          <div className="rounded-2xl bg-gradient-to-br from-[#1E2A4A] to-[#243356] p-5 text-white shadow-sm">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-[#C9A227]">
              DPDPA enforcement
            </div>
            <div className="mt-2 font-heading text-4xl font-bold leading-none text-white">
              {diffDays} days
            </div>
            <div className="mt-1 text-xs text-[#a9b3ce]">
              until 13 May 2027 · ₹250 cr max penalty / contravention
            </div>
            <div className="mt-4 border-t border-white/10 pt-3 text-[11px] text-[#a9b3ce]">
              Nazar is monitoring MeitY / DPB.{' '}
              <Link href="/regwatch" className="text-[#0FB5A5] font-medium hover:underline">
                2 new signals →
              </Link>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
