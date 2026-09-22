'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { AgentIcon } from '@axiom/ui';
import type { AgentName } from '@axiom/types';
import { invokeAgent, AgentInvocationError } from '@/lib/invoke-agent';

interface WorkbenchClientProps {
  userEmail: string;
  ledgerTodayCount: number;
  awaitingReviewCount: number;
  recentRuns: any[];
  pendingPlans: any[];
  dataResidencyRegion: string;
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
    desc: 'Classifies discovered data into 9 statutory categories.',
    autonomy: 'L1',
  },
  {
    name: 'parikshan',
    label: 'Parikshan',
    role: 'Assessment',
    desc: 'Scores compliance posture against control library v25.11.2.',
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
    desc: 'Watches MeitY gazette feeds, DPB orders & tribunal rulings.',
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
    role: 'Continuous Surveillance',
    desc: 'Signal monitor & post-remediation regression monitoring.',
    autonomy: 'L1',
  },
];

export function AgentWorkbenchClient({
  userEmail,
  ledgerTodayCount,
  awaitingReviewCount,
  recentRuns,
  pendingPlans,
  dataResidencyRegion,
}: WorkbenchClientProps) {
  const [selectedAgent, setSelectedAgent] = useState<AgentName>('drishti');
  const [isExecuting, setIsExecuting] = useState(false);
  const [runResult, setRunResult] = useState<{
    status: string;
    latency_ms?: number;
    ledgerIds?: string[];
    message?: string;
  } | null>(null);

  const handleRun = async () => {
    if (isExecuting) return;
    setIsExecuting(true);
    setRunResult(null);

    try {
      const data = await invokeAgent(selectedAgent, { scope: 'workbench' });
      setRunResult({
        status: data.status,
        latency_ms: data.latency_ms,
        ledgerIds: data.ledger_entry_ids,
      });
    } catch (error) {
      setRunResult({
        status: 'failed',
        message:
          error instanceof AgentInvocationError
            ? error.message
            : 'Could not confirm the agent outcome.',
      });
    } finally {
      setIsExecuting(false);
    }
  };

  return (
    <div className="mx-auto max-w-[1180px] space-y-5 animate-fade-in">
      {/* Design System Hero Banner */}
      <div className="rounded-2xl bg-gradient-to-br from-[#1E2A4A] to-[#243356] p-6 sm:p-7 text-white shadow-sm">
        <div className="flex flex-wrap items-center gap-2.5 mb-2.5">
          <span className="rounded bg-[#0FB5A5] px-2 py-0.5 text-[9px] font-semibold text-[#04322d] tracking-wide">
            P0
          </span>
          <div className="flex items-center gap-1.5 text-[11px] font-medium text-[#0FB5A5]">
            <span>Agent ·</span>
            <span className="inline-flex items-center gap-1">
              <AgentIcon
                agent={selectedAgent}
                size="xs"
                variant="on-dark"
                state={isExecuting ? 'working' : 'idle'}
              />
              <span className="capitalize">{selectedAgent} (fleet)</span>
            </span>
          </div>
          <span className="text-[11px] text-[#8a97b8]">Autonomy —</span>
          <span className="ml-auto rounded border border-teal-500/30 bg-teal-500/10 px-2.5 py-0.5 text-[11px] font-medium text-teal-300">
            Env: Production · {dataResidencyRegion}
          </span>
        </div>
        <div className="flex flex-wrap items-baseline gap-3">
          <h1 className="font-heading text-2xl sm:text-[26px] font-bold text-white tracking-tight">
            Agent Workbench
          </h1>
          <span className="font-heading text-lg sm:text-[18px] text-[#0FB5A5]">
            एजेंट कार्यक्षेत्र
          </span>
        </div>
        <p className="mt-2 text-[13px] text-[#c7cfe0] max-w-3xl leading-relaxed">
          The founder’s and admin cockpit: run any agent, review every output before it reaches a
          client, and manage the versioned prompt / model registry across on-prem and cloud
          environments. High-throughput review is a first-class product surface.
        </p>
        <div className="mt-3.5 inline-flex items-center gap-2 rounded-full bg-white/[0.08] px-3 py-1 text-[11px] text-slate-200">
          <span className="text-[#C9A227]">◆</span> Sold standalone or bundled · module M0.6
        </div>
      </div>

      {/* 2 Top Cards as per Design System */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Card 1: Agent fleet */}
        <div className="rounded-2xl border border-[#e4e8ee] bg-white p-5 sm:p-6 shadow-sm">
          <div className="font-heading text-[14px] font-semibold text-[#1E2A4A] mb-3 flex items-center justify-between">
            <span>Agent fleet</span>
            <span className="rounded bg-teal-50 px-2 py-0.5 text-[11px] font-medium text-teal-700">
              10 / 10 Online
            </span>
          </div>
          <div className="divide-y divide-[#eef1f5]">
            <div className="flex items-center justify-between py-2.5">
              <div className="flex items-center gap-2.5">
                <span className="h-2 w-2 rounded-xs bg-[#0FB5A5]" />
                <span className="text-[12.5px] text-[#2F3542]">Agents online</span>
              </div>
              <span className="font-mono text-[11.5px] font-semibold text-[#0FB5A5]">10 / 10</span>
            </div>
            <div className="flex items-center justify-between py-2.5">
              <div className="flex items-center gap-2.5">
                <span className="h-2 w-2 rounded-xs bg-[#1E2A4A]" />
                <span className="text-[12.5px] text-[#2F3542]">Runs today</span>
              </div>
              <span className="font-mono text-[11.5px] font-semibold text-[#1E2A4A]">
                {ledgerTodayCount}
              </span>
            </div>
            <div className="flex items-center justify-between py-2.5">
              <div className="flex items-center gap-2.5">
                <span className="h-2 w-2 rounded-xs bg-[#E0A82E]" />
                <span className="text-[12.5px] text-[#2F3542]">
                  Awaiting founder / admin review
                </span>
              </div>
              <span className="font-mono text-[11.5px] font-semibold text-[#8a6d10]">
                {awaitingReviewCount}
              </span>
            </div>
          </div>
        </div>

        {/* Card 2: Prompt registry */}
        <div className="rounded-2xl border border-[#e4e8ee] bg-white p-5 sm:p-6 shadow-sm">
          <div className="font-heading text-[14px] font-semibold text-[#1E2A4A] mb-3 flex items-center justify-between">
            <span>Prompt registry</span>
            <span className="rounded bg-indigo-50 px-2 py-0.5 text-[11px] font-medium text-indigo-700">
              v25.11.2
            </span>
          </div>
          <div className="divide-y divide-[#eef1f5]">
            <div className="flex items-center justify-between py-2.5">
              <div className="flex items-center gap-2.5">
                <span className="h-2 w-2 rounded-xs bg-[#1E2A4A]" />
                <span className="text-[12.5px] text-[#2F3542]">Versioned prompts</span>
              </div>
              <span className="font-mono text-[11.5px] font-semibold text-[#1E2A4A]">64</span>
            </div>
            <div className="flex items-center justify-between py-2.5">
              <div className="flex items-center gap-2.5">
                <span className="h-2 w-2 rounded-xs bg-[#0FB5A5]" />
                <span className="text-[12.5px] text-[#2F3542]">Model gateway</span>
              </div>
              <span className="font-mono text-[11.5px] font-semibold text-[#0FB5A5]">
                abstracted
              </span>
            </div>
            <div className="flex items-center justify-between py-2.5">
              <div className="flex items-center gap-2.5">
                <span className="h-2 w-2 rounded-xs bg-[#0FB5A5]" />
                <span className="text-[12.5px] text-[#2F3542]">Prompt drift</span>
              </div>
              <span className="font-mono text-[11.5px] font-semibold text-[#0FB5A5]">
                0 untracked
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Cockpit Execution & Review Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_420px] gap-5 items-start">
        {/* Left: Interactive Agent Execution Trigger & Fleet Status */}
        <div className="space-y-4">
          <div className="rounded-2xl border border-[#e4e8ee] bg-white p-5 sm:p-6 shadow-sm">
            <div className="font-heading text-[14px] font-semibold text-[#1E2A4A] mb-3">
              ⚡ Execute & Test Autonomous Agent
            </div>
            <p className="text-xs text-[#5b6270] mb-4">
              Trigger any agent directly through the API gateway. Execution outputs are logged in
              the immutable audit ledger with cryptographic sequence proofs.
            </p>

            <div className="flex flex-wrap items-center gap-3">
              <select
                value={selectedAgent}
                disabled={isExecuting}
                onChange={(e) => setSelectedAgent(e.target.value as AgentName)}
                className="h-9 rounded-lg border border-[#e4e8ee] bg-white px-3 text-xs font-semibold text-[#1E2A4A] focus:outline-none focus:ring-2 focus:ring-[#0FB5A5]"
              >
                {AGENTS.map((a) => (
                  <option key={a.name} value={a.name}>
                    {a.label} ({a.role}) — {a.autonomy}
                  </option>
                ))}
              </select>

              <button
                type="button"
                onClick={handleRun}
                disabled={isExecuting}
                className="inline-flex items-center gap-1.5 rounded-lg bg-[#0FB5A5] px-4 py-2 text-xs font-semibold text-white shadow-xs hover:bg-[#0a8d80] transition-colors cursor-pointer disabled:opacity-50"
              >
                {isExecuting ? (
                  <>
                    <span className="h-3 w-3 animate-spin rounded-full border-2 border-white border-t-transparent" />
                    Executing {selectedAgent}…
                  </>
                ) : (
                  <>⚡ Run {selectedAgent}</>
                )}
              </button>
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
            <div className="border-b border-[#e4e8ee] bg-[#F4F6F8] px-5 py-3 text-xs font-semibold text-[#1E2A4A] flex items-center justify-between">
              <span>Recent Agent Activity Stream (Audit Ledger)</span>
              <Link
                href="/ledger"
                className="text-[11px] font-semibold text-[#0FB5A5] hover:underline"
              >
                View full ledger ↗
              </Link>
            </div>
            <div className="divide-y divide-[#eef1f5]">
              {recentRuns.length === 0 ? (
                <div className="p-6 text-center text-xs text-slate-500">
                  No agent runs recorded yet.
                </div>
              ) : (
                recentRuns.map((r) => (
                  <div
                    key={r.seq}
                    className="flex items-center justify-between p-3.5 hover:bg-slate-50 transition-colors"
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <span className="font-mono text-[11px] text-slate-400 shrink-0">
                        #{r.seq}
                      </span>
                      <AgentIcon agent={r.actor || 'system'} size="xs" />
                      <div className="min-w-0 truncate">
                        <div className="text-xs font-semibold text-slate-800 truncate">
                          {r.action}
                        </div>
                        <div className="text-[10.5px] text-slate-400 font-mono truncate">
                          {r.target_ref || 'ap-south-1'} · Corr: {r.correlation_id?.slice(0, 8)}…
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0 ml-3">
                      <span className="font-mono text-[10px] text-slate-400">
                        {r.timestamp
                          ? new Date(r.timestamp).toLocaleTimeString('en-IN')
                          : 'Recently'}
                      </span>
                      <span className="rounded bg-teal-50 px-1.5 py-0.5 text-[10px] font-medium text-teal-700">
                        ✓ {r.result || 'success'}
                      </span>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>

        {/* Right: High-Throughput Review Queue */}
        <div className="space-y-4">
          <div className="rounded-2xl border border-[#e4e8ee] bg-white p-5 shadow-sm">
            <div className="font-heading text-[14px] font-semibold text-[#1E2A4A] mb-1">
              Founder & Admin Review Queue
            </div>
            <p className="text-xs text-[#5b6270] mb-3">
              Every plan generated by Sudhaar must be dry-run and approved before Karya mutates
              production data.
            </p>

            <div className="divide-y divide-[#eef1f5] mb-4">
              {pendingPlans.length === 0 ? (
                <div className="py-4 text-center text-xs text-slate-500">
                  0 plans awaiting review.
                </div>
              ) : (
                pendingPlans.map((p) => (
                  <div key={p.id} className="py-2.5 flex items-center justify-between">
                    <div className="min-w-0">
                      <div className="text-xs font-semibold text-slate-800 truncate">{p.title}</div>
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
                ))
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
              <span className="font-mono font-medium text-slate-900">{dataResidencyRegion}</span>
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
