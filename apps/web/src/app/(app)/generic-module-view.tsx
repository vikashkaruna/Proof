'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AgentIcon } from '@axiom/ui';
import type { AgentName } from '@axiom/types';

export interface ModuleCardRow {
  t: string;
  v: string;
  dot: string;
  sub?: string;
}

export interface ModuleCard {
  h: string;
  rows: ModuleCardRow[];
  badge?: string;
}

export interface ModuleTelemetryEvent {
  seq?: number;
  title: string;
  detail: string;
  time: string;
  target?: string;
  tag?: string;
  tagColor?: string;
  hash?: string;
  status?: string;
}

export interface GenericModuleMeta {
  title: string;
  hi: string;
  phase: string;
  agent?: string;
  agentKey?: AgentName | string;
  agentKeys?: Array<AgentName | string>;
  autonomy: string;
  moduleId: string;
  desc: string;
  actionLabel?: string;
  actionHref?: string;
  statutoryCitation?: string;
  cards: ModuleCard[];
  recentEvents?: ModuleTelemetryEvent[];
  telemetryTitle?: string;
}

export function GenericModuleView({
  meta,
  isDemo = false,
  children,
}: {
  meta: GenericModuleMeta;
  /**
   * Whether this tenant may be shown the illustrative figures in `meta.cards`.
   *
   * Those figures are hardcoded — "12.4M rows", "47 tables", "8,210 files" —
   * and used to render for everyone. On a compliance product that is the most
   * damaging possible default: a real client sees invented numbers presented
   * as their own posture, indistinguishable from a genuine finding, in a
   * product sold on the basis that its output can be shown to a regulator.
   *
   * Opt-in per tenant (`tenants.is_demo`), and visibly labelled when on.
   */
  isDemo?: boolean;
  children?: React.ReactNode;
}) {
  const router = useRouter();
  const [isExecuting, setIsExecuting] = useState(false);
  const [runResult, setRunResult] = useState<{
    success: boolean;
    status?: string;
    message: string;
    latency_ms?: number;
    ledgerIds?: string[];
  } | null>(null);

  const handleRunAgent = async () => {
    if (!meta.agentKey || isExecuting) return;
    setIsExecuting(true);
    setRunResult(null);

    try {
      const res = await fetch(`/api/bff/v1/agents/${meta.agentKey}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope: `${meta.agentKey}_module_screen` }),
      });

      const data = await res.json();

      if (data?.output?.status === 'denied' || data?.status === 'denied') {
        setRunResult({
          success: false,
          status: 'denied',
          message:
            data.output?.error ||
            'Refused: Mutating actions require an issued Human Approval Token (ADR-1 / ADR-3).',
          latency_ms: data.latency_ms,
        });
      } else if (res.ok && (data.status === 'succeeded' || data.agent)) {
        setRunResult({
          success: true,
          status: 'succeeded',
          message: `Agent ${meta.agentKey} executed successfully.`,
          latency_ms: data.latency_ms,
          ledgerIds: data.ledger_entry_ids,
        });
        router.refresh();
      } else {
        setRunResult({
          success: false,
          status: 'failed',
          message: data?.error?.message || data?.error || 'Execution failed. Inspect system logs.',
        });
      }
    } catch (err: any) {
      setRunResult({
        success: false,
        status: 'error',
        message: err?.message || 'Network error invoking compliance agent',
      });
    } finally {
      setIsExecuting(false);
    }
  };

  return (
    <div className="mx-auto max-w-[1140px] space-y-5 animate-in fade-in-0 duration-200">
      {/* ============================================================ */}
      {/* 1. HERO BANNER WITH LIVE ACTION CONTROLS                     */}
      {/* ============================================================ */}
      <div className="rounded-2xl bg-gradient-to-br from-[#1E2A4A] via-[#1E2A4A] to-[#243356] p-6 md:p-7 text-white shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex-1 min-w-[280px]">
            {/* Phase, Agent, Autonomy Badges */}
            <div className="mb-2.5 flex flex-wrap items-center gap-2">
              <span className="rounded bg-[#0FB5A5] px-2 py-0.5 text-[9px] font-bold text-[#04322d] uppercase tracking-wider">
                {meta.phase}
              </span>
              {meta.agent && (
                <div className="flex flex-wrap items-center gap-1.5 text-xs font-semibold text-[#0FB5A5]">
                  <span>Agent ·</span>
                  {meta.agent.includes('+') ? (
                    meta.agent.split('+').map((partRaw, idx) => {
                      const part = partRaw.trim();
                      const key =
                        meta.agentKeys?.[idx] ??
                        (meta.agentKey && idx === 0 ? meta.agentKey : part.toLowerCase());
                      return (
                        <React.Fragment key={idx}>
                          {idx > 0 && <span className="text-[#0FB5A5]/70">+</span>}
                          <span className="inline-flex items-center gap-1">
                            <AgentIcon
                              agent={key}
                              size="xs"
                              variant="on-dark"
                              state={isExecuting ? 'working' : 'idle'}
                            />
                            <span>{part}</span>
                          </span>
                        </React.Fragment>
                      );
                    })
                  ) : (
                    <span className="inline-flex items-center gap-1">
                      {meta.agentKey && (
                        <AgentIcon
                          agent={meta.agentKey}
                          size="xs"
                          variant="on-dark"
                          state={isExecuting ? 'working' : 'idle'}
                        />
                      )}
                      <span>{meta.agent}</span>
                    </span>
                  )}
                </div>
              )}
              <span className="text-xs text-[#8a97b8]">Autonomy {meta.autonomy}</span>
              {meta.statutoryCitation && (
                <span className="rounded bg-white/10 px-2 py-0.5 font-mono text-[10px] text-[#C9A227]">
                  {meta.statutoryCitation}
                </span>
              )}
            </div>

            {/* Title & Indic Transliteration */}
            <div className="flex items-baseline gap-3">
              <h1 className="font-heading text-2xl md:text-[26px] font-bold text-white tracking-tight">
                {meta.title}
              </h1>
              <span className="font-heading text-lg text-[#0FB5A5] font-normal">{meta.hi}</span>
            </div>

            {/* Description */}
            <p className="mt-2 max-w-3xl text-xs leading-relaxed text-[#c7cfe0]">{meta.desc}</p>

            <div className="mt-4 flex flex-wrap items-center gap-3">
              <div className="inline-flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1 text-[11px] text-white">
                <span className="text-[#C9A227]">◆</span> Module {meta.moduleId} · DPDPA 2023
                Statutory Suite
              </div>
              <div className="inline-flex items-center gap-1.5 rounded-full bg-teal-500/20 border border-teal-500/30 px-3 py-1 text-[11px] text-[#0FB5A5] font-mono">
                <span className="h-1.5 w-1.5 rounded-full bg-[#0FB5A5] animate-pulse" />
                ap-south-1 domestic
              </div>
            </div>
          </div>

          {/* Action Trigger Button */}
          {meta.actionHref ? (
            <Link
              href={meta.actionHref}
              className="rounded-[9px] bg-[#0FB5A5] hover:bg-[#0da294] text-white text-xs font-bold py-2.5 px-4 flex items-center gap-2 shadow-sm transition-all"
            >
              <span>⚡</span>
              <span>{meta.actionLabel || 'Review & Approve in Console →'}</span>
            </Link>
          ) : meta.actionLabel && meta.agentKey ? (
            <button
              type="button"
              onClick={handleRunAgent}
              disabled={isExecuting}
              className="cursor-pointer rounded-[9px] bg-[#0FB5A5] hover:bg-[#0da294] disabled:opacity-60 text-white text-xs font-bold py-2.5 px-4 flex items-center gap-2 shadow-sm transition-all"
            >
              <span>⚡</span>
              <span>{isExecuting ? 'Invoking Agent…' : meta.actionLabel}</span>
            </button>
          ) : null}
        </div>

        {/* Live Execution Feedback */}
        {isExecuting && (
          <div className="mt-4 rounded-lg border border-teal-400/40 bg-teal-950/40 p-2.5 text-xs text-teal-200 flex items-center gap-2 animate-in fade-in-0 duration-150">
            <span className="animate-spin font-bold text-[#0FB5A5]">↻</span>
            <span>Invoking {meta.agent || 'compliance agent'}… verifying statutory bounds…</span>
          </div>
        )}

        {runResult && !isExecuting && (
          <div
            className={`mt-4 rounded-lg border p-2.5 text-xs flex flex-col gap-1 animate-in fade-in-0 duration-150 ${
              runResult.success
                ? 'border-emerald-400/50 bg-emerald-950/40 text-emerald-200'
                : runResult.status === 'denied'
                  ? 'border-amber-400/50 bg-amber-950/40 text-amber-200'
                  : 'border-rose-400/50 bg-rose-950/40 text-rose-200'
            }`}
          >
            <div className="flex items-center justify-between font-semibold">
              <span>
                {runResult.success
                  ? '✓ Task executed successfully'
                  : runResult.status === 'denied'
                    ? '🔒 Architectural gate enforced'
                    : '✕ Invocation error'}
              </span>
              {runResult.latency_ms !== undefined && (
                <span className="font-mono text-[10px] opacity-75">{runResult.latency_ms}ms</span>
              )}
            </div>
            <p className="text-[11.5px] leading-tight opacity-90">{runResult.message}</p>
            {runResult.ledgerIds && runResult.ledgerIds.length > 0 && (
              <div className="flex items-center gap-1 text-[11px] pt-1">
                <span className="opacity-75">Immutable ledger proof:</span>
                <Link
                  href={`/ledger?q=${runResult.ledgerIds[0]}`}
                  className="font-mono underline text-teal-300 hover:text-white"
                >
                  #{runResult.ledgerIds.join(', #')}
                </Link>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ============================================================ */}
      {/* 2. DYNAMIC CARDS GRID                                        */}
      {/* ============================================================ */}
      {isDemo && meta.cards.length > 0 && (
        <div className="mb-3 flex items-center gap-2 rounded-xl border border-[#C9A227]/30 bg-[#C9A227]/5 px-3.5 py-2.5">
          <span className="h-1.5 w-1.5 shrink-0 rounded-sm bg-[#C9A227]" />
          <p className="text-[11px] leading-tight text-[#6b5a14]">
            <span className="font-semibold">Sample data.</span> The figures below are illustrative,
            not measured from this estate. They appear because this tenant is flagged for
            demonstration.
          </p>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {(isDemo ? meta.cards : []).map((c, idx) => (
          <div
            key={idx}
            className="rounded-2xl border border-[#e4e8ee] bg-white p-5 shadow-2xs hover:shadow-xs transition-shadow"
          >
            <div className="flex items-center justify-between mb-3">
              <h2 className="font-heading text-sm font-semibold text-[#1E2A4A]">{c.h}</h2>
              {c.badge && (
                <span className="text-[10px] font-semibold text-[#8a909b] uppercase tracking-wider">
                  {c.badge}
                </span>
              )}
            </div>
            <div className="divide-y divide-[#eef1f5]">
              {c.rows.map((r, rIdx) => (
                <div key={rIdx} className="flex items-center gap-2.5 py-2.5">
                  <span
                    style={{ backgroundColor: r.dot }}
                    className="h-1.5 w-1.5 shrink-0 rounded-sm"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="text-xs text-[#2F3542] font-medium truncate">{r.t}</div>
                    {r.sub && (
                      <div className="text-[10.5px] text-[#8a909b] leading-tight">{r.sub}</div>
                    )}
                  </div>
                  <span className="font-mono text-xs font-semibold text-[#1E2A4A] shrink-0">
                    {r.v}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      {!isDemo && meta.cards.length > 0 && (
        <div className="rounded-2xl border border-dashed border-[#e4e8ee] bg-[#fafbfc] p-8 text-center">
          <h2 className="font-heading text-sm font-semibold text-[#1E2A4A]">
            Nothing measured yet
          </h2>
          <p className="mx-auto mt-1.5 max-w-md text-xs leading-relaxed text-[#8a909b]">
            This module has no results for your estate. Once {meta.agent ?? 'the responsible agent'}{' '}
            has run, its findings and the ledger entries behind them appear here.
          </p>
        </div>
      )}

      {children}

      {/* ============================================================ */}
      {/* 3. RECENT TELEMETRY STREAM FROM ACTUAL LEDGER                */}
      {/* ============================================================ */}
      {meta.recentEvents && meta.recentEvents.length > 0 && (
        <div className="rounded-2xl border border-[#e4e8ee] bg-white overflow-hidden shadow-2xs">
          <div className="flex items-center justify-between px-5 py-3.5 border-b border-[#e4e8ee] bg-[#F4F6F8]">
            <div className="flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-[#0FB5A5] animate-pulse" />
              <h3 className="font-heading text-xs font-semibold text-[#1E2A4A] uppercase tracking-wider">
                {meta.telemetryTitle || 'Recent Agent Executions & Proof Ledger'}
              </h3>
            </div>
            <Link
              href={meta.agentKey ? `/ledger?agent=${meta.agentKey}` : '/ledger'}
              className="text-[11px] font-medium text-[#0a8d80] hover:underline"
            >
              View all in Audit Ledger →
            </Link>
          </div>

          <div className="divide-y divide-[#eef1f5]">
            {meta.recentEvents.map((e, idx) => (
              <div
                key={idx}
                className="flex items-center gap-3 px-5 py-3 hover:bg-[#F4F6F8]/50 transition-colors"
              >
                {e.seq !== undefined && (
                  <Link
                    href={`/ledger?q=${e.seq}`}
                    className="font-mono text-xs font-semibold text-[#1E2A4A] hover:underline w-12 shrink-0"
                  >
                    #{e.seq}
                  </Link>
                )}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-semibold text-[#2F3542]">{e.title}</span>
                    {e.target && (
                      <span className="font-mono text-[10px] bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded">
                        {e.target}
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 text-[11px] text-[#8a909b] truncate">
                    {e.detail}
                    {e.hash && (
                      <span className="ml-2 font-mono text-[10px]">H:{e.hash.slice(0, 10)}…</span>
                    )}
                  </div>
                </div>
                <div className="text-right shrink-0">
                  <div className="text-[10.5px] text-[#8a909b] font-mono">{e.time}</div>
                  <div className="text-[10px] font-semibold text-[#0a8d80]">
                    {e.status || '✓ verified'}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ============================================================ */}
      {/* 4. INSTITUTIONAL LIVE OPERATIONS BAR (REPLACES MOCK NOTE)    */}
      {/* ============================================================ */}
      <div className="rounded-xl border border-teal-200 bg-[#E5FAF7] p-4 text-xs text-[#0a6b61] flex flex-wrap items-center justify-between gap-3 shadow-2xs">
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-[#0FB5A5] animate-pulse" />
          <span>
            <strong>Live Compliance Telemetry:</strong> Connected to statutory audit ledger &
            autonomous compliance engine. All client data resides strictly in sovereign Indian
            region (<code>ap-south-1</code> Mumbai).
          </span>
        </div>
        <div className="flex items-center gap-3 font-medium text-[11px]">
          <Link href="/ledger" className="underline hover:text-teal-950">
            Audit Ledger ↗
          </Link>
          <span>·</span>
          <Link href="/workbench" className="underline hover:text-teal-950">
            Agent Workbench ↗
          </Link>
        </div>
      </div>
    </div>
  );
}
