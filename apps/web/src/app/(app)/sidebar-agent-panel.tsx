'use client';

import React, { useState, useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { AgentName } from '@axiom/types';
import { invokeAgent, AgentInvocationError } from '@/lib/invoke-agent';
import { AgentIcon, type AgentIconState, Badge } from '@axiom/ui';
import { agentAccents } from '@axiom/design-tokens';

export interface AgentActionMeta {
  name: AgentName;
  persona: string;
  indic: string;
  autonomy: string;
  phase: string;
  description: string;
  statutoryBoundary: string;
  modulePath: string;
  moduleLabel: string;
  actionLabel: string;
  isGated?: boolean;
}

export const ALL_AGENTS: AgentActionMeta[] = [
  {
    name: 'drishti',
    persona: 'Discovery',
    indic: 'दृष्टि · Data Discovery',
    autonomy: 'L1 Autonomous',
    phase: 'Phase 1 · Discovery',
    description:
      'Inspects registered systems through authorized discovery connectors and records observed findings.',
    statutoryBoundary:
      'Deployment region and data flows must be verified from the connected estate.',
    modulePath: '/discovery',
    moduleLabel: 'Data Discovery',
    actionLabel: 'Run Discovery Scan',
  },
  {
    name: 'vibhaag',
    persona: 'Classification',
    indic: 'विभाग · Classification',
    autonomy: 'L1 Autonomous',
    phase: 'Phase 1 · Classification',
    description:
      'Classifies observed personal-data fields using configured patterns and records review needs.',
    statutoryBoundary:
      'A classification is a recorded finding; legal interpretation requires human review.',
    modulePath: '/classification',
    moduleLabel: 'Data Classification',
    actionLabel: 'Run Classification',
  },
  {
    name: 'parikshan',
    persona: 'Assessment',
    indic: 'परीक्षण · Assessment',
    autonomy: 'L1 Autonomous',
    phase: 'Phase 0 · 46 Controls',
    description:
      'Evaluates recorded assessment inputs against the versioned control library.',
    statutoryBoundary:
      'Review scoring inputs, source controls, and gap rationales before relying on the result.',
    modulePath: '/assessment',
    moduleLabel: 'Control Assessment',
    actionLabel: 'Run 46-Control Assessment',
  },
  {
    name: 'saakshi',
    persona: 'Evidence',
    indic: 'साक्षी · Evidence',
    autonomy: 'L1 Autonomous',
    phase: 'Phase 2 · WORM Vault',
    description:
      'Seals evidence artifacts and audit snapshots into immutable WORM storage with cryptographic SHA-256 hashes.',
    statutoryBoundary:
      'S3 Object Lock in Compliance mode. Multi-year retention prevents premature deletion or tamper.',
    modulePath: '/evidence',
    moduleLabel: 'Evidence Explorer',
    actionLabel: 'Seal Attestation Proof',
  },
  {
    name: 'sudhaar',
    persona: 'Remediation',
    indic: 'सुधार · Remediation',
    autonomy: 'L1 Autonomous',
    phase: 'Phase 3 · Blueprints',
    description:
      'Synthesizes remediation blueprints with step-by-step actions, blast radius caps, and reversible rollbacks.',
    statutoryBoundary:
      'Separation of duties (ADR-3): Sudhaar is strictly read-only (can_mutate = False). Holds zero write credentials.',
    modulePath: '/plans',
    moduleLabel: 'Remediation Plans',
    actionLabel: 'Generate Remediation Plan',
  },
  {
    name: 'karya',
    persona: 'Execution',
    indic: 'कार्य · Execution',
    autonomy: 'L2 Approval-Gated',
    phase: 'Phase 3 · Mutations',
    description:
      'Mutating execution engine. Executes only actions covered by a verified, signed, scope-bound human approval token.',
    statutoryBoundary:
      'ADR-1 & ADR-2: Refuses execution without validated dry-run, rollback, and signed human approval token.',
    modulePath: '/approval',
    moduleLabel: 'Approval Console',
    actionLabel: 'Review & Approve in Console',
    isGated: true,
  },
  {
    name: 'lekha',
    persona: 'Audit',
    indic: 'लेखा · Audit',
    autonomy: 'L1 Autonomous',
    phase: 'Phase 2 · Ledger',
    description:
      'Verifies the append-only, tamper-evident audit ledger and reconstructs unbroken SHA-256 cryptographic hash chains.',
    statutoryBoundary:
      'Ledger writes are restricted to append_ledger() SECURITY DEFINER Postgres function.',
    modulePath: '/ledger',
    moduleLabel: 'Audit Ledger',
    actionLabel: 'Verify Ledger Chain',
  },
  {
    name: 'nazar',
    persona: 'Regulatory Watch',
    indic: 'नज़र · Surveillance',
    autonomy: 'L1 Autonomous',
    phase: 'Phase 2 · RegWatch',
    description:
      'Regulatory Watch source feeds are unavailable until authoritative publications and retained citations are connected.',
    statutoryBoundary:
      'Do not rely on an unverified countdown or notification as legal intelligence.',
    modulePath: '/regwatch',
    moduleLabel: 'Regulatory Watch',
    actionLabel: 'Open Regulatory Watch',
  },
  {
    name: 'prativedan',
    persona: 'Reporting',
    indic: 'प्रतिवेदन · Reports',
    autonomy: 'L1 Autonomous',
    phase: 'Phase 2 · Board Packs',
    description:
      'Compiles executive Board compliance packs, RoPA summaries, and auditor-ready submission dossiers.',
    statutoryBoundary:
      'Zero raw PII egress. All sensitive personal data is redacted prior to report rendering.',
    modulePath: '/reports',
    moduleLabel: 'Compliance Reports',
    actionLabel: 'Compile Board Report',
  },
  {
    name: 'sanket',
    persona: 'Market Signal',
    indic: 'संकेत · Signal',
    autonomy: 'L1 Autonomous',
    phase: 'Phase 1 · Threat Signals',
    description:
      'Monitors breach telemetry, CERT-In vulnerability disclosures, and commercial privacy procurement intent.',
    statutoryBoundary:
      'Continuous signal telemetry surveillance without exposing tenant personal data.',
    modulePath: '/breaches',
    moduleLabel: 'Breach & Signals',
    actionLabel: 'Scan Market & Breach Signals',
  },
  {
    name: 'samadhan',
    persona: 'Reconciliation',
    indic: 'समाधान · Maker-Checker',
    autonomy: 'L1 Autonomous',
    phase: 'Phase 3 · Dual Control',
    description:
      'Maker-checker reconciler. Verifies executed reality against approved scope, detects parameter drift, and cryptographically signs the dual-control statement.',
    statutoryBoundary:
      'Evaluates token scope post-execution. Refuses out-of-scope executions and signs immutable statement with approval-keyed HMAC.',
    modulePath: '/execution',
    moduleLabel: 'Execution Batches',
    actionLabel: 'Verify Batch Reconciliation',
  },
  {
    name: 'pramaan',
    persona: 'Closure Seal',
    indic: 'प्रमाण · Statutory Proof',
    autonomy: 'L1 Autonomous',
    phase: 'Phase 5 · Proof Seal',
    description:
      'Statutory closure authority. Synthesizes multi-agent proof dossiers, Merkle trees, and WORM evidence archives, applying the sovereign Gold ProofSeal.',
    statutoryBoundary:
      'Master synthesis for DPB statutory submissions and Board closure packs. Non-mutating authority backed by Founder co-signature.',
    modulePath: '/reports',
    moduleLabel: 'Compliance Reports',
    actionLabel: 'Synthesize Closure Dossier',
  },
];

const DIRECT_AGENT_NAMES = new Set<AgentName>(['drishti', 'vibhaag', 'lekha']);

export interface SidebarAgentPanelProps {
  transparent?: boolean;
  systemMessage?: string;
  className?: string;
  showSystemMessage?: boolean;
}

export function SidebarAgentPanel({
  transparent = false,
  systemMessage,
  className = '',
  showSystemMessage = true,
}: SidebarAgentPanelProps = {}) {
  const router = useRouter();
  const [activeAgentNames, setActiveAgentNames] = useState<Set<string> | null>(null);
  const [activeRunCount, setActiveRunCount] = useState(0);
  const [selectedAgent, setSelectedAgent] = useState<AgentActionMeta | null>(null);

  // Execution state tracking
  const [isExecuting, setIsExecuting] = useState(false);
  const [lastRunResult, setLastRunResult] = useState<{
    success: boolean;
    status?: string;
    message: string;
    latency_ms?: number;
    ledgerIds?: string[];
    error?: string;
  } | null>(null);

  // Close flyout on Escape key
  useEffect(() => {
    if (!selectedAgent) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setSelectedAgent(null);
        setLastRunResult(null);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedAgent]);

  // Poll for live active agent runs every 4 seconds
  useEffect(() => {
    let isMounted = true;

    async function fetchActive() {
      try {
        const res = await fetch('/api/bff/v1/agents/runs/active');
        if (!res.ok) {
          if (isMounted) {
            setActiveAgentNames(null);
            setActiveRunCount(0);
          }
          return;
        }
        const data = await res.json();
        if (isMounted && Array.isArray(data?.active_runs) &&
          data.active_runs.every((run: unknown) => run && typeof run === 'object' &&
            'agent_name' in run && typeof run.agent_name === 'string')) {
          const names = new Set<string>();
          for (const run of data.active_runs) {
            names.add(run.agent_name.toLowerCase());
          }
          setActiveAgentNames(names);
          setActiveRunCount(data.active_runs.length);
        } else if (isMounted) {
          setActiveAgentNames(null);
          setActiveRunCount(0);
        }
      } catch {
        if (isMounted) {
          setActiveAgentNames(null);
          setActiveRunCount(0);
        }
      }
    }

    fetchActive();
    const interval = setInterval(fetchActive, 4000);
    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, []);

  const getAgentState = (name: string): AgentIconState => {
    return activeAgentNames?.has(name) ? 'working' : 'idle';
  };

  // Run agent action via BFF API
  const handleRunAgent = async (agent: AgentActionMeta) => {
    if (isExecuting || !DIRECT_AGENT_NAMES.has(agent.name)) return;
    setIsExecuting(true);
    setLastRunResult(null);

    try {
      const data = await invokeAgent(agent.name, { scope: 'manual_trigger' });
      setLastRunResult({
        success: true,
        status: 'succeeded',
        message: `Agent ${agent.name} completed.`,
        latency_ms: data.latency_ms,
        ledgerIds: data.ledger_entry_ids,
      });
      router.refresh();
    } catch (error) {
      setLastRunResult({
        success: false,
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

  const activeCount = activeAgentNames === null ? 0 : activeRunCount;
  const currentBroadcast =
    systemMessage ||
    (activeAgentNames === null
      ? 'Agent-run status unavailable'
      : activeCount > 0
      ? `${activeCount} agent run(s) reported active`
      : 'No active agent runs reported');

  return (
    <div
      className={`border-t border-slate-200 bg-[#F8FAFC] p-3 select-none text-slate-800 transition-colors ${
        transparent ? 'bg-transparent border-white/10 text-white' : ''
      } ${className}`}
    >
      {/* Panel Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
            Agents ({ALL_AGENTS.length})
          </p>
          {activeCount > 0 && (
            <span className="flex h-1.5 w-1.5 rounded-full bg-[#0FB5A5] animate-ping" />
          )}
        </div>
      </div>

      {/* 12 Agent Mini Icons Grid (3 rows x 4) */}
      <div className="mt-2.5 grid grid-cols-4 gap-1.5">
        {ALL_AGENTS.map((agent) => {
          const state = getAgentState(agent.name);
          const isSelected = selectedAgent?.name === agent.name;
          const accent = agentAccents[agent.name] || '#0FB5A5';

          return (
            <button
              key={agent.name}
              type="button"
              onClick={() => {
                setSelectedAgent(isSelected ? null : agent);
                setLastRunResult(null);
              }}
              title={`${agent.name} (${agent.persona}) · Status: ${activeAgentNames === null ? 'unavailable' : state}`}
              className={`group relative flex flex-col items-center justify-center rounded-lg p-1 transition-all cursor-pointer ${
                isSelected
                  ? 'bg-slate-200/90 ring-1 ring-slate-400 shadow-2xs'
                  : 'hover:bg-slate-200/60'
              }`}
            >
              <AgentIcon
                agent={agent.name}
                state={state}
                size="sm"
                showBadge={state === 'working'}
                className="transition-transform group-hover:scale-105"
              />
              <span
                className="mt-1 truncate text-[9px] font-medium capitalize max-w-full"
                style={{
                  color: state === 'working' ? accent : isSelected ? '#0F172A' : '#64748B',
                }}
              >
                {agent.name}
              </span>
            </button>
          );
        })}
      </div>

      {/* System-wide Agent Message / Status Bar */}
      {showSystemMessage && (
        <div className="mt-2.5 flex items-center gap-1.5 rounded-lg border border-slate-200 bg-slate-100/90 px-2 py-1 text-[9px] text-slate-700 font-mono">
          <span
            className={`h-1.5 w-1.5 shrink-0 rounded-full ${
              activeCount > 0 ? 'bg-teal-500 animate-pulse' : 'bg-slate-400'
            }`}
          />
          <span className="truncate font-mono tracking-tight text-slate-600">
            {currentBroadcast}
          </span>
        </div>
      )}

      {/* Interactive Detail Inspector with Actions */}
      {selectedAgent && (
        <div className="mt-2.5 rounded-lg border border-slate-200 bg-white p-2.5 shadow-md text-slate-800 animate-in fade-in-0 duration-150">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <span
                className="h-2 w-2 rounded-full"
                style={{ backgroundColor: agentAccents[selectedAgent.name] }}
              />
              <span className="font-heading text-xs font-semibold capitalize text-slate-900">
                {selectedAgent.name}
              </span>
              <span className="text-[10px] text-slate-500">· {selectedAgent.persona}</span>
            </div>
            <button
              type="button"
              onClick={() => {
                setSelectedAgent(null);
                setLastRunResult(null);
              }}
              className="text-[11px] text-slate-400 hover:text-slate-700 transition-colors cursor-pointer"
            >
              ✕
            </button>
          </div>

          <p className="mt-1 text-[11px] text-slate-600 leading-tight">
            {selectedAgent.description}
          </p>

          <div className="mt-2 flex items-center justify-between border-t border-slate-100 pt-1.5 text-[10px]">
            <span className="text-slate-500">
              Autonomy:{' '}
              <strong className="text-indigo-600 font-semibold">{selectedAgent.autonomy}</strong>
            </span>
            <span className="font-medium capitalize text-slate-700">
              State:{' '}
              <strong
                className={
                  getAgentState(selectedAgent.name) === 'working'
                    ? 'text-teal-600 font-semibold'
                    : 'text-slate-600'
                }
              >
                {activeAgentNames === null ? 'unavailable' : getAgentState(selectedAgent.name)}
              </strong>
            </span>
          </div>

          {/* Live Execution Feedback */}
          {isExecuting && (
            <div className="mt-2 rounded border border-teal-200 bg-teal-50 p-1.5 text-[10px] text-teal-800 flex items-center gap-1.5">
              <span className="animate-spin font-bold text-teal-600">↻</span>
              <span>Invoking {selectedAgent.name}…</span>
            </div>
          )}

          {lastRunResult && !isExecuting && (
            <div
              className={`mt-2 rounded border p-1.5 text-[10px] flex flex-col gap-0.5 ${
                lastRunResult.success
                  ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                  : lastRunResult.status === 'denied'
                    ? 'border-amber-200 bg-amber-50 text-amber-900'
                    : 'border-rose-200 bg-rose-50 text-rose-800'
              }`}
            >
              <div className="flex items-center justify-between font-semibold">
                <span>
                  {lastRunResult.success
                    ? '✓ Succeeded'
                    : lastRunResult.status === 'denied'
                      ? '🔒 Gate enforced'
                      : '✕ Error'}
                </span>
                {lastRunResult.latency_ms !== undefined && (
                  <span className="font-mono text-[9px] opacity-75">
                    {lastRunResult.latency_ms}ms
                  </span>
                )}
              </div>
              <p className="leading-tight opacity-90 text-[9.5px]">{lastRunResult.message}</p>
              {lastRunResult.ledgerIds && lastRunResult.ledgerIds.length > 0 && (
                <div className="text-[9.5px]">
                  <span className="opacity-75">Ledger proof: </span>
                  <Link
                    href={`/ledger?q=${lastRunResult.ledgerIds[0]}`}
                    className="font-mono underline text-teal-700"
                  >
                    #{lastRunResult.ledgerIds.join(', #')}
                  </Link>
                </div>
              )}
            </div>
          )}

          {/* Action Buttons Suite */}
          <div className="mt-2.5 flex flex-col gap-1.5 pt-2 border-t border-slate-100">
            {!DIRECT_AGENT_NAMES.has(selectedAgent.name) ? (
              <Link
                href={selectedAgent.modulePath}
                className="w-full rounded-md bg-[#1E2A4A] hover:bg-[#151e35] text-white text-[11px] font-semibold py-1.5 px-2.5 flex items-center justify-center gap-1 shadow-2xs transition-colors text-center"
              >
                <span>{selectedAgent.actionLabel} →</span>
              </Link>
            ) : (
              <button
                type="button"
                onClick={() => handleRunAgent(selectedAgent)}
                disabled={isExecuting}
                className="w-full rounded-md bg-[#0FB5A5] hover:bg-[#0da294] disabled:opacity-60 text-white text-[11px] font-semibold py-1.5 px-2.5 flex items-center justify-center gap-1.5 shadow-2xs transition-colors cursor-pointer"
              >
                <span>⚡</span>
                <span>{isExecuting ? 'Executing…' : selectedAgent.actionLabel}</span>
              </button>
            )}

            <div className="flex items-center justify-between gap-1 text-[10px] text-slate-500 font-medium pt-0.5">
              <Link
                href={selectedAgent.modulePath}
                className="hover:text-indigo-600 hover:underline"
              >
                {selectedAgent.moduleLabel} →
              </Link>
              <span className="text-slate-300">·</span>
              <Link
                href={`/workbench?agent=${selectedAgent.name}`}
                className="hover:text-indigo-600 hover:underline"
              >
                Workbench ↗
              </Link>
              <span className="text-slate-300">·</span>
              <Link
                href={`/ledger?agent=${selectedAgent.name}`}
                className="hover:text-indigo-600 hover:underline"
              >
                Ledger ↗
              </Link>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
