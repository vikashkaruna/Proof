'use client';

import React, { useLayoutEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AgentLabel, DataPlaceholder, PageHeader } from '@axiom/ui';
import type { AgentName } from '@axiom/types';
import { invokeAgent, AgentInvocationError } from '@/lib/invoke-agent';
import { moduleBarProps } from '@/lib/module-bar';
import { moduleMeta, type ModuleKey } from '@/lib/module-meta';

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
  moduleKey: ModuleKey;
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
  canInvokeAgent = false,
  tenantId = null,
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
  canInvokeAgent?: boolean;
  tenantId?: string | null;
  children?: React.ReactNode;
}) {
  const router = useRouter();
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
    success: boolean;
    status?: string;
    message: string;
    latency_ms?: number;
    ledgerIds?: string[];
  } | null>(null);

  const runResult = recordedResult?.tenantId === tenantId ? recordedResult : null;

  const handleRunAgent = async () => {
    if (!meta.agentKey || !canInvokeAgent || !tenantId || busy) return;
    const attemptTenant = tenantId;
    setExecutingTenant(attemptTenant);
    setRunResult(null);

    try {
      const data = await invokeAgent(meta.agentKey, attemptTenant, { scope: 'manual_trigger' });
      if (currentTenant.current !== attemptTenant) return;
      setRunResult({
        tenantId: attemptTenant,
        success: true,
        status: 'succeeded',
        message: `Agent ${meta.agentKey} completed.`,
        latency_ms: data.latency_ms,
        ledgerIds: data.ledger_entry_ids,
      });
      try {
        router.refresh();
      } catch {
        // A page refresh failure cannot invalidate the confirmed agent receipt.
      }
    } catch (error) {
      if (currentTenant.current !== attemptTenant) return;
      setRunResult({
        tenantId: attemptTenant,
        success: false,
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
    <div className="w-full min-w-0 space-y-4 animate-in fade-in-0 duration-200">
      <PageHeader
        title={moduleMeta(meta.moduleKey).title}
        module={moduleBarProps(meta.moduleKey)}
        description={meta.desc}
        meta={
          <>
            <span className="rounded bg-white/10 px-1.5 py-0.5 text-[10.5px] font-medium text-[#D6DBE8]">
              Autonomy {meta.autonomy}
            </span>
            {meta.statutoryCitation && (
              <span className="rounded bg-white/10 px-1.5 py-0.5 font-mono text-[10.5px] text-[#D6DBE8]">
                {meta.statutoryCitation}
              </span>
            )}
            {isExecuting && meta.agentKey && (
              <AgentLabel agent={meta.agentKey} size="xs" tone="dark" state="working" />
            )}
          </>
        }
        actions={
          meta.actionHref ? (
            <Link
              href={meta.actionHref}
              data-primary
              className="inline-flex min-h-9 items-center gap-1.5 rounded-md bg-[#0FB5A5] px-3.5 py-2 text-xs font-semibold text-white transition-colors hover:bg-[#0C9184]"
            >
              {meta.actionLabel || 'Review & Approve in Console'}
            </Link>
          ) : meta.actionLabel && meta.agentKey && canInvokeAgent ? (
            <button
              type="button"
              onClick={handleRunAgent}
              disabled={busy || !tenantId}
              data-primary
              className="inline-flex min-h-9 cursor-pointer items-center gap-1.5 rounded-md bg-[#0FB5A5] px-3.5 py-2 text-xs font-semibold text-white transition-colors hover:bg-[#0C9184] disabled:opacity-60"
            >
              {isExecuting ? 'Invoking agent…' : meta.actionLabel}
            </button>
          ) : undefined
        }
      >
        {isExecuting ? (
          <div className="flex items-center gap-2 rounded-lg border border-teal-400/40 bg-teal-950/40 p-2.5 text-xs text-teal-200">
            <span className="animate-spin font-bold text-[#0FB5A5]">↻</span>
            <span>Invoking {meta.agent || 'compliance agent'}…</span>
          </div>
        ) : runResult ? (
          <div
            className={`flex flex-col gap-1 rounded-lg border p-2.5 text-xs ${
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
                  ? 'Task executed successfully'
                  : runResult.status === 'denied'
                    ? 'Architectural gate enforced'
                    : 'Invocation error'}
              </span>
              {runResult.latency_ms !== undefined && (
                <span className="font-mono text-[10px] opacity-75">{runResult.latency_ms}ms</span>
              )}
            </div>
            <p className="text-[11.5px] leading-tight opacity-90">{runResult.message}</p>
            {runResult.ledgerIds && runResult.ledgerIds.length > 0 && (
              <div className="flex items-center gap-1 pt-1 text-[11px]">
                <span className="opacity-75">Immutable ledger proof:</span>
                <Link
                  href={`/ledger?q=${runResult.ledgerIds[0]}`}
                  className="font-mono text-teal-300 underline hover:text-white"
                >
                  #{runResult.ledgerIds.join(', #')}
                </Link>
              </div>
            )}
          </div>
        ) : null}
      </PageHeader>

      {/* ============================================================ */}
      {/* 2. DYNAMIC CARDS GRID                                        */}
      {/* ============================================================ */}
      {isDemo && meta.cards.length > 0 && (
        <div className="mb-3 flex items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3.5 py-2.5">
          <span className="h-1.5 w-1.5 shrink-0 rounded-sm bg-slate-500" />
          <p className="text-[11px] leading-tight text-slate-700">
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
        <DataPlaceholder
          title="Nothing measured yet"
          description="This page has no measured results for your estate. Check the recorded workflows and audit ledger for completed work."
        />
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
                className="flex flex-col gap-2 px-4 py-3 hover:bg-[#F4F6F8]/50 transition-colors sm:px-5 lg:flex-row lg:items-start lg:gap-3"
              >
                {e.seq !== undefined && (
                  <Link
                    href={`/ledger?q=${e.seq}`}
                    className="font-mono text-xs font-semibold text-[#1E2A4A] hover:underline shrink-0 lg:w-12"
                  >
                    #{e.seq}
                  </Link>
                )}
                <div className="flex-1 min-w-0">
                  <div className="flex flex-col gap-1 sm:flex-row sm:flex-wrap sm:items-start sm:gap-2">
                    <span className="text-xs font-semibold text-[#2F3542] [overflow-wrap:anywhere]">
                      {e.title}
                    </span>
                    {e.target && (
                      <span className="max-w-full break-all font-mono text-[10px] bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded">
                        {e.target}
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 text-[11px] text-[#8a909b] [overflow-wrap:anywhere]">
                    {e.detail}
                    {e.hash && (
                      <span className="ml-2 font-mono text-[10px]">H:{e.hash.slice(0, 10)}…</span>
                    )}
                  </div>
                </div>
                <div className="min-w-0 [overflow-wrap:anywhere] lg:max-w-64 lg:shrink-0 lg:text-right">
                  <div className="text-[10.5px] text-[#8a909b] font-mono">{e.time}</div>
                  <div className="text-[10px] font-semibold text-[#0a8d80]">
                    {e.status || 'Status unavailable'}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ============================================================ */}
      {/* 4. Tenant-scoped recorded activity is available to every signed-in member. */}
      {/* ============================================================ */}
      <div className="rounded-xl border border-teal-200 bg-[#E5FAF7] p-4 text-xs text-[#0a6b61] flex flex-wrap items-center justify-between gap-3 shadow-2xs">
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-[#0FB5A5] animate-pulse" />
          <span>
            View tenant-scoped recorded activity in the Client Portal. This page does not verify
            service health or deployment region.
          </span>
        </div>
        <div className="flex items-center gap-3 font-medium text-[11px]">
          <Link href="/portal" className="underline hover:text-teal-950">
            Client Portal ↗
          </Link>
        </div>
      </div>
    </div>
  );
}
