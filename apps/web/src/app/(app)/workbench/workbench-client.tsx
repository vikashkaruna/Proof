'use client';

import React, { useLayoutEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { AgentIcon, AgentLabel, PageHeader } from '@axiom/ui';
import type { AgentName } from '@axiom/types';
import { invokeAgent, AgentInvocationError } from '@/lib/invoke-agent';
import { moduleBarProps } from '@/lib/module-bar';

interface RecentRun {
  seq: number;
  actor: string;
  action: string;
  target_ref: string | null;
  correlation_id: string;
  timestamp: string;
  result: string;
}

interface PendingPlan {
  id: string;
  title: string;
  status: string;
  version: number;
  created_at: string;
}

interface WorkbenchClientProps {
  tenantId: string;
  userEmail: string;
  /** Ledger entries recorded today; null when the count could not be read. */
  ledgerTodayCount: number | null;
  /** Plans in draft or review; null when unreadable. */
  awaitingReviewCount: number | null;
  recentRuns: RecentRun[] | null;
  pendingPlans: PendingPlan[] | null;
  dataResidencyRegion: string;
  /** Deployment label from configuration, not a claim about health. */
  environment: string;
  loadError: boolean;
}

const AGENTS: Array<{
  name: AgentName;
  label: string;
  role: string;
  desc: string;
  autonomy: string;
}> = [
  {
    name: 'drishti',
    label: 'Drishti',
    role: 'Data Discovery',
    desc: 'Scans cloud datastores, catalogs schemas, samples PII.',
    autonomy: 'L1',
  },
  {
    name: 'vibhaag',
    label: 'Vibhaag',
    role: 'Classification',
    desc: 'Classifies observed personal-data fields using configured patterns.',
    autonomy: 'L1',
  },
  {
    name: 'parikshan',
    label: 'Parikshan',
    role: 'Assessment',
    desc: 'Scores compliance posture against the published control library.',
    autonomy: 'L1',
  },
  {
    name: 'sudhaar',
    label: 'Sudhaar',
    role: 'Remediation Planning',
    desc: 'Proposes typed remediation plans with mandatory rollback.',
    autonomy: 'L1 (read-only)',
  },
  {
    name: 'karya',
    label: 'Karya',
    role: 'Execution',
    desc: 'Executes approved actions with token verification & kill switch.',
    autonomy: 'L2 (token-gated)',
  },
  {
    name: 'saakshi',
    label: 'Saakshi',
    role: 'Evidence Collection',
    desc: 'Seals evidence artifacts into S3 WORM Compliance vault.',
    autonomy: 'L1',
  },
  {
    name: 'prativedan',
    label: 'Prativedan',
    role: 'Reporting',
    desc: 'Generates Board packs, auditor dossiers, and DPB filings.',
    autonomy: 'L1',
  },
  {
    name: 'nazar',
    label: 'Nazar',
    role: 'Regulatory Watch',
    desc: 'Regulatory feed integration is unavailable pending authoritative sources.',
    autonomy: 'L1',
  },
  {
    name: 'lekha',
    label: 'Lekha',
    role: 'Audit Ledger',
    desc: 'Cryptographic append-only ledger witness & hash chaining.',
    autonomy: 'L1',
  },
  {
    name: 'sanket',
    label: 'Sanket',
    role: 'Public Market Observations',
    desc: 'Public observations require configured capture transport and human review.',
    autonomy: 'L1',
  },
  {
    name: 'samadhan',
    label: 'Samadhan',
    role: 'Maker-Checker Reconciliation',
    desc: 'Dual-key authority validator & maker-checker reconciliation engine.',
    autonomy: 'L2 (token-gated)',
  },
  {
    name: 'pramaan',
    label: 'Pramaan',
    role: 'Statutory Closure Seal',
    desc: 'Statutory compliance closure authority & sovereign evidence sealing.',
    autonomy: 'L1 (read/seal)',
  },
];

const WORKFLOW_HREF: Partial<Record<AgentName, string>> = {
  parikshan: '/assessment',
  sudhaar: '/plans',
  karya: '/approval',
  saakshi: '/evidence',
  prativedan: '/reports',
  nazar: '/regwatch',
  sanket: '/breaches',
  samadhan: '/execution',
  pramaan: '/reports',
};

export function AgentWorkbenchClient({
  tenantId,
  userEmail,
  ledgerTodayCount,
  awaitingReviewCount,
  recentRuns,
  pendingPlans,
  environment,
  loadError,
  dataResidencyRegion,
}: WorkbenchClientProps) {
  const [selectedAgent, setSelectedAgent] = useState<AgentName>('drishti');
  const currentTenant = useRef<string | null>(tenantId);
  const mounted = useRef(false);
  useLayoutEffect(() => {
    mounted.current = true;
    currentTenant.current = tenantId;
    return () => {
      mounted.current = false;
      currentTenant.current = null;
    };
  }, [tenantId]);
  const [executingTenant, setExecutingTenant] = useState<string | null>(null);
  const busy = executingTenant !== null;
  const isExecuting = busy && executingTenant === tenantId;
  const [recordedResult, setRunResult] = useState<{
    tenantId: string;
    status: string;
    latency_ms?: number;
    ledgerIds?: string[];
    message?: string;
  } | null>(null);
  const runResult = recordedResult?.tenantId === tenantId ? recordedResult : null;
  const workflowHref = WORKFLOW_HREF[selectedAgent];

  const handleRun = async () => {
    if (busy || WORKFLOW_HREF[selectedAgent]) return;
    const attemptTenant = tenantId;
    setExecutingTenant(attemptTenant);
    setRunResult(null);

    try {
      const data = await invokeAgent(selectedAgent, attemptTenant, { scope: 'workbench' });
      if (currentTenant.current !== attemptTenant) return;
      setRunResult({
        tenantId: attemptTenant,
        status: data.status,
        latency_ms: data.latency_ms,
        ledgerIds: data.ledger_entry_ids,
      });
    } catch (error) {
      if (currentTenant.current !== attemptTenant) return;
      setRunResult({
        tenantId: attemptTenant,
        status: 'failed',
        message:
          error instanceof AgentInvocationError
            ? error.message
            : 'Could not confirm the agent outcome.',
      });
    } finally {
      if (mounted.current) setExecutingTenant(null);
    }
  };

  return (
    <div className="w-full min-w-0 space-y-4 animate-fade-in">
      <PageHeader
        title="Agent Workbench"
        module={moduleBarProps('workbench')}
        description="Inspect recorded activity and launch supported read-only agents. Approval-gated actions, evidence storage, reports and unavailable feeds use their dedicated workflows."
        meta={
          <>
            <AgentLabel
              agent={selectedAgent}
              size="xs"
              tone="dark"
              state={isExecuting ? 'working' : 'idle'}
            />
            <span className="rounded bg-white/10 px-1.5 py-0.5 text-[10.5px] font-medium text-[#D6DBE8]">
              Autonomy: set per agent
            </span>
            <span className="rounded border border-teal-500/30 bg-teal-500/10 px-1.5 py-0.5 text-[10.5px] font-medium text-teal-300">
              Env: {environment} · configured region target: {dataResidencyRegion}
            </span>
          </>
        }
      />

      {loadError && (
        <div
          role="alert"
          className="rounded-xl border border-[#D9534F]/30 bg-[#D9534F]/5 px-4 py-3 text-xs text-[#9b2c2c]"
        >
          Some workbench data could not be loaded. Counts marked unavailable were not substituted.
        </div>
      )}

      {/* 2 Top Cards as per Design System */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Card 1: Agent fleet */}
        <div className="rounded-2xl border border-[#e4e8ee] bg-white p-5 sm:p-6 shadow-sm">
          <div className="font-heading text-[14px] font-semibold text-[#1E2A4A] mb-3 flex items-center justify-between">
            <span className="flex items-center gap-2">
              <span className="h-2.5 w-2.5 rounded-full bg-[#0FB5A5]" />
              <span>Agent fleet</span>
            </span>
            <span className="rounded bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600">
              Health not monitored here
            </span>
          </div>
          <div className="divide-y divide-[#eef1f5]">
            <div className="flex items-center justify-between py-2.5">
              <div className="flex items-center gap-2.5">
                <span className="h-2 w-2 rounded-xs bg-[#1E2A4A]" />
                <span className="text-[12.5px] text-[#2F3542]">Ledger entries today</span>
              </div>
              <span
                className="font-mono text-[11.5px] font-semibold text-[#1E2A4A]"
                data-testid="workbench-ledger-today"
              >
                {ledgerTodayCount ?? 'Unavailable'}
              </span>
            </div>
            <div className="flex items-center justify-between py-2.5">
              <div className="flex items-center gap-2.5">
                <span className="h-2 w-2 rounded-xs bg-[#E0A82E]" />
                <span className="text-[12.5px] text-[#2F3542]">
                  Awaiting founder / admin review
                </span>
              </div>
              <span
                className="font-mono text-[11.5px] font-semibold text-[#B45309]"
                data-testid="workbench-awaiting-review"
              >
                {awaitingReviewCount ?? 'Unavailable'}
              </span>
            </div>
          </div>
          {/* Quick Agent Selection Grid */}
          <div className="mt-3.5 pt-3 border-t border-[#eef1f5]">
            <div className="text-[10.5px] font-semibold text-slate-500 uppercase tracking-wider mb-2">
              Select agent or workflow
            </div>
            <div className="grid grid-cols-4 sm:grid-cols-6 gap-1.5">
              {AGENTS.map((a) => (
                <button
                  type="button"
                  key={a.name}
                  onClick={() => setSelectedAgent(a.name)}
                  className={`p-1.5 rounded-lg border text-center transition-all cursor-pointer ${
                    selectedAgent === a.name
                      ? 'border-[#0FB5A5] bg-[#0FB5A5]/10 shadow-xs'
                      : 'border-[#e4e8ee] hover:bg-slate-50'
                  }`}
                  title={`${a.label} — ${a.role} (${a.autonomy})`}
                >
                  <AgentIcon
                    agent={a.name}
                    size="xs"
                    state={selectedAgent === a.name && isExecuting ? 'working' : 'idle'}
                  />
                  <div className="text-[9.5px] font-semibold text-slate-700 truncate mt-0.5">
                    {a.label}
                  </div>
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Card 2: Prompt registry — C-W0-7: no registry exists yet, so no figures are shown. */}
        <div className="rounded-2xl border border-[#e4e8ee] bg-white p-5 sm:p-6 shadow-sm flex flex-col justify-between">
          <div>
            <div className="font-heading text-[14px] font-semibold text-[#1E2A4A] mb-3 flex items-center justify-between">
              <span className="flex items-center gap-2">
                <span className="h-2.5 w-2.5 rounded-full bg-[#1E2A4A]" />
                <span>Prompt registry</span>
              </span>
              <span className="rounded bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600">
                Not yet available
              </span>
            </div>
            <p
              className="text-[12.5px] text-[#5b6270] leading-relaxed"
              data-testid="workbench-prompt-registry"
            >
              The versioned prompt and model registry is not implemented yet. Prompt versions, drift
              and model-gateway health will be shown here once they are recorded.
            </p>
          </div>
          <p className="mt-4 border-t border-[#eef1f5] pt-3 text-[11px] text-slate-500">
            Gateway location and redaction health require runtime checks; no status is inferred
            here.
          </p>
        </div>
      </div>

      {/* Cockpit Execution & Review Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_420px] gap-5 items-start">
        {/* Left: Interactive Agent Execution Trigger & Fleet Status */}
        <div className="space-y-4">
          <div className="rounded-2xl border border-[#e4e8ee] bg-white p-5 sm:p-6 shadow-sm">
            <div className="font-heading text-[14px] font-semibold text-[#1E2A4A] mb-2 flex items-center justify-between">
              <span>Agent action</span>
              <span className="text-[11px] font-mono text-[#0FB5A5] font-semibold">
                Scope: Workbench / Test
              </span>
            </div>
            <p className="text-xs text-[#5b6270] mb-4">
              Supported read-only agents can be invoked through the API gateway. Use the linked
              workflow for approval, storage, reports, and unavailable feeds.
            </p>

            <div className="flex flex-wrap items-center gap-3">
              <select
                value={selectedAgent}
                disabled={busy}
                onChange={(e) => setSelectedAgent(e.target.value as AgentName)}
                className="h-9 rounded-lg border border-[#e4e8ee] bg-white px-3 text-xs font-semibold text-[#1E2A4A] focus:outline-none focus:ring-2 focus:ring-[#0FB5A5]"
              >
                {AGENTS.map((a) => (
                  <option key={a.name} value={a.name}>
                    {a.label} ({a.role}) — {a.autonomy}
                  </option>
                ))}
              </select>

              {workflowHref ? (
                <Link
                  href={workflowHref}
                  className="inline-flex items-center rounded-lg bg-[#1E2A4A] px-4 py-2 text-xs font-semibold text-white"
                >
                  Open {selectedAgent} workflow
                </Link>
              ) : (
                <button
                  type="button"
                  onClick={handleRun}
                  disabled={busy}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-[#0FB5A5] px-4 py-2 text-xs font-semibold text-white shadow-xs hover:bg-[#0a8d80] transition-colors cursor-pointer disabled:opacity-50"
                >
                  {isExecuting ? `Running ${selectedAgent}…` : `Run ${selectedAgent}`}
                </button>
              )}
            </div>

            {runResult && (
              <div
                role={runResult.status === 'succeeded' ? 'status' : 'alert'}
                className={`mt-3 rounded-lg border p-3 text-xs ${runResult.status === 'succeeded' ? 'border-teal-200 bg-teal-50/70 text-teal-900' : 'border-red-200 bg-red-50 text-red-900'}`}
              >
                <div className="flex items-center justify-between">
                  <span className="font-semibold">
                    {runResult.status === 'succeeded'
                      ? `✓ Execution completed (${runResult.latency_ms}ms)`
                      : runResult.message || 'Agent invocation failed.'}
                  </span>
                  {runResult.ledgerIds?.map((id) => (
                    <Link
                      key={id}
                      href={`/ledger?q=${id}`}
                      className="font-mono text-[11px] underline text-teal-800 hover:text-teal-950"
                    >
                      Ledger entry #{id} ↗
                    </Link>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Recent Multi-Agent Execution Stream */}
          <div className="rounded-2xl border border-[#e4e8ee] bg-white overflow-hidden shadow-sm">
            <div className="border-b border-[#e4e8ee] bg-[#F4F6F8] px-5 py-3 text-xs font-semibold text-[#1E2A4A] flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="font-heading text-sm font-semibold text-[#1E2A4A]">
                  Recent Ledger Activity
                </span>
                <span className="rounded bg-[#1E2A4A] px-2 py-0.5 text-[10px] font-mono text-white">
                  Audit Ledger
                </span>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-[11px] text-slate-500 font-mono">
                  {recentRuns === null ? 'Unavailable' : `${recentRuns.length} loaded`}
                </span>
                <Link
                  href="/ledger"
                  className="text-[11px] font-semibold text-[#0FB5A5] hover:underline"
                >
                  View full ledger ↗
                </Link>
              </div>
            </div>

            {/* Table Header Control */}
            <div className="grid grid-cols-[80px_130px_minmax(140px,1fr)_120px_100px_90px] gap-2 px-4 py-2.5 bg-[#f8fafc] border-b border-[#eef1f5] text-[10.5px] font-semibold uppercase tracking-wider text-slate-500">
              <div>Seq #</div>
              <div>Actor / Agent</div>
              <div>Action & Resource</div>
              <div>Correlation</div>
              <div>Result</div>
              <div className="text-right">Time (IST)</div>
            </div>

            {recentRuns === null ? (
              <p role="alert" className="text-xs text-slate-500">
                Recent ledger activity is unavailable.
              </p>
            ) : recentRuns.length === 0 ? (
              <div className="p-8 text-center bg-white space-y-3">
                <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-teal-50 border border-teal-200 text-[#0FB5A5]">
                  ⚡
                </div>
                <div className="space-y-1">
                  <div className="text-xs font-semibold text-[#1E2A4A]">
                    No agent runs recorded yet.
                  </div>
                  <p className="text-[11.5px] text-slate-500 max-w-md mx-auto">
                    When autonomous agents (Drishti, Parikshan, Sudhaar, Karya, Saakshi, etc.)
                    record ledger events for this tenant, the saved events appear here after
                    refresh.
                  </p>
                </div>
                {workflowHref ? (
                  <Link
                    href={workflowHref}
                    className="inline-flex items-center rounded-lg bg-[#1E2A4A] px-3.5 py-1.5 text-xs font-semibold text-white"
                  >
                    Open selected workflow
                  </Link>
                ) : (
                  <button
                    type="button"
                    onClick={handleRun}
                    disabled={busy}
                    className="inline-flex items-center rounded-lg bg-[#0FB5A5] px-3.5 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
                  >
                    Run selected agent
                  </button>
                )}
              </div>
            ) : (
              <div className="divide-y divide-[#eef1f5]">
                {recentRuns.map((r) => (
                  <div
                    key={r.seq}
                    className="grid grid-cols-[80px_130px_minmax(140px,1fr)_120px_100px_90px] gap-2 items-center px-4 py-3 hover:bg-slate-50 transition-colors text-xs"
                  >
                    <span className="font-mono text-[11px] font-semibold text-[#1E2A4A]">
                      #{r.seq}
                    </span>
                    <div className="flex items-center gap-2 min-w-0">
                      <AgentIcon agent={r.actor || 'system'} size="xs" />
                      <span className="font-medium text-slate-800 capitalize truncate">
                        {r.actor}
                      </span>
                    </div>
                    <div className="min-w-0">
                      <div className="font-medium text-slate-900 truncate">{r.action}</div>
                      <div className="text-[10.5px] text-slate-400 font-mono truncate">
                        {r.target_ref || '—'}
                      </div>
                    </div>
                    <span className="font-mono text-[11px] text-slate-500 truncate">
                      {r.correlation_id.slice(0, 8)}…
                    </span>
                    <div>
                      <span
                        className={`rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider ${
                          r.result === 'success'
                            ? 'bg-[#e6f7f5] text-[#0a8d80]'
                            : 'bg-[#fbeceb] text-[#D9534F]'
                        }`}
                      >
                        {r.result}
                      </span>
                    </div>
                    <div className="text-right font-mono text-[11px] text-slate-500">
                      {new Date(r.timestamp).toLocaleTimeString('en-IN', {
                        hour: '2-digit',
                        minute: '2-digit',
                        second: '2-digit',
                      })}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Right: High-Throughput Review Queue */}
        <div className="space-y-4">
          <div className="rounded-2xl border border-[#e4e8ee] bg-white p-5 shadow-sm">
            <div className="font-heading text-[14px] font-semibold text-[#1E2A4A] mb-1 flex items-center justify-between">
              <span>Founder & Admin Review Queue</span>
              <span className="rounded bg-amber-50 text-amber-800 border border-amber-200 px-2 py-0.5 text-[10px] font-bold uppercase">
                BR-1 / BR-2 Gate
              </span>
            </div>
            <p className="text-xs text-[#5b6270] mb-3 leading-relaxed">
              Every plan generated by Sudhaar must be dry-run and approved before Karya mutates
              production data.
            </p>

            <div className="mb-4">
              {pendingPlans === null ? (
                <p role="alert" className="text-xs text-slate-500">
                  Review plans are unavailable.
                </p>
              ) : pendingPlans.length === 0 ? (
                <div className="rounded-xl border border-dashed border-slate-200 bg-[#F4F6F8]/70 p-4 text-center space-y-2">
                  <div className="mx-auto flex h-8 w-8 items-center justify-center rounded-full bg-emerald-50 text-[#0a8d80] text-sm">
                    ✓
                  </div>
                  <div className="text-xs font-semibold text-[#1E2A4A]">
                    0 plans awaiting review.
                  </div>
                  <p className="text-[11px] text-slate-500 leading-normal">
                    No draft or review plans were returned for this tenant. This does not establish
                    that all plans are reconciled or approved.
                  </p>
                  <div className="flex justify-center gap-1.5 pt-1">
                    <span className="rounded bg-white border border-slate-200 px-2 py-0.5 text-[9.5px] font-mono text-slate-600">
                      Dry-run required before approval
                    </span>
                    <span className="rounded bg-white border border-slate-200 px-2 py-0.5 text-[9.5px] font-mono text-slate-600">
                      Validated rollback required
                    </span>
                  </div>
                </div>
              ) : (
                <div className="divide-y divide-[#eef1f5]">
                  {pendingPlans.map((p) => (
                    <div key={p.id} className="py-2.5 flex items-center justify-between">
                      <div className="min-w-0">
                        <div className="text-xs font-semibold text-slate-800 truncate">
                          {p.title}
                        </div>
                        <div className="text-[10px] text-slate-400">
                          Plan v{p.version} · Status: {p.status}
                        </div>
                      </div>
                      <Link
                        href="/approval"
                        className="shrink-0 ml-2 rounded bg-amber-50 border border-amber-200 px-2 py-0.5 text-[10px] font-semibold text-amber-800 hover:bg-amber-100"
                      >
                        Review →
                      </Link>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <Link
              href="/approval"
              className="block text-center rounded-lg bg-[#1E2A4A] py-2 text-xs font-semibold text-white hover:bg-[#243356] transition-colors"
            >
              Open Approval Console →
            </Link>
          </div>

          <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm text-xs space-y-2">
            <div className="font-semibold text-slate-800">Deployment Telemetry</div>
            <div className="flex justify-between text-slate-600">
              <span>Target Region</span>
              <span className="font-mono font-medium text-slate-900">
                Configured target: {dataResidencyRegion}; verify deployment
              </span>
            </div>
            <div className="flex justify-between text-slate-600">
              <span>Admin Operator</span>
              <span className="font-mono text-[11px] text-slate-900 truncate max-w-[180px]">
                {userEmail}
              </span>
            </div>
            <div className="flex justify-between text-slate-600">
              <span>Ledger Writer Role</span>
              <span className="font-medium text-teal-700">SECURITY DEFINER</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
