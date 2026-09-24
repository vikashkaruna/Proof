'use client';

import React, { useState, useEffect } from 'react';
import { usePersistentState } from '@/lib/use-persistent-state';
import { AgentIcon } from '@axiom/ui';

export interface ActionItem {
  id: string;
  title: string;
  type: string;
  risk: 'LOW' | 'MED' | 'HIGH';
  target: string;
  blast: number;
  why: string;
  citation: string;
  riskReason: string;
  dryAge: string;
  dryHash: string;
  rollbackRef: string;
  rollback: string;
  blastCards: Array<{ v: string; l: string }>;
  diff: Array<{ sign: string; text: string; style: string }>;
}

export type ActionStatus =
  'pending' | 'approved' | 'executing' | 'executed' | 'verified' | 'rejected' | 'deferred';

type FilterTab = 'pending' | 'verified' | 'deferred' | 'rejected' | 'all';

interface OutcomeBanner {
  type: 'success' | 'amber' | 'rose' | 'info';
  title: string;
  detail: string;
  hash?: string;
  timestamp: string;
}

/**
 * Stable empty defaults. `usePersistentState` uses the fallback as its server
 * snapshot and inside its snapshot memo, so an inline `{}` literal would be a
 * new object on every render and defeat the cache.
 */
const NO_STATUSES: Record<string, ActionStatus> = {};
const NO_DEFER_NOTES: Record<string, string> = {};

export function ApprovalConsoleClient({ initialActions }: { initialActions: ActionItem[] }) {
  const actionsData = initialActions.length > 0 ? initialActions : [];
  const firstId = actionsData[0]?.id || 'ACT-01';

  const [selected, setSelected] = useState<Record<string, boolean>>({ [firstId]: true });
  // Persisted across reloads; rendered from the server snapshot during
  // hydration, then swapped without an effect.
  const [statuses, setStatuses] = usePersistentState<Record<string, ActionStatus>>(
    'axiom_approval_statuses',
    NO_STATUSES,
  );
  const [selId, setSelId] = useState<string>(firstId);
  const [filterTab, setFilterTab] = useState<FilterTab>('pending');
  const [outcome, setOutcome] = useState<OutcomeBanner | null>(null);

  // Deferral Modal State
  const [deferModalOpen, setDeferModalOpen] = useState(false);
  const [deferringIds, setDeferringIds] = useState<string[]>([]);
  const [deferReason, setDeferReason] = useState(
    'Scheduled for off-peak maintenance window (Saturday 02:00 IST)',
  );
  const [deferDuration, setDeferDuration] = useState('24 Hours');
  const [deferNotes, setDeferNotes] = usePersistentState<Record<string, string>>(
    'axiom_defer_notes',
    NO_DEFER_NOTES,
  );

  // Auto-dismiss outcome banner after 8 seconds
  useEffect(() => {
    if (!outcome) return;
    const timer = setTimeout(() => {
      setOutcome(null);
    }, 8000);
    return () => clearTimeout(timer);
  }, [outcome]);

  const selectedAction = actionsData.find((a) => a.id === selId) || actionsData[0];

  // Dynamic counts
  const pendingActions = actionsData.filter((a) => (statuses[a.id] || 'pending') === 'pending');
  const pendingCount = pendingActions.length;
  const verifiedCount = actionsData.filter((a) =>
    ['approved', 'executing', 'executed', 'verified'].includes(statuses[a.id] || 'pending'),
  ).length;
  const deferredCount = actionsData.filter((a) => statuses[a.id] === 'deferred').length;
  const rejectedCount = actionsData.filter((a) => statuses[a.id] === 'rejected').length;

  // Filtered list
  const filteredActions = actionsData.filter((a) => {
    const st = statuses[a.id] || 'pending';
    if (filterTab === 'pending') return st === 'pending';
    if (filterTab === 'verified')
      return ['approved', 'executing', 'executed', 'verified'].includes(st);
    if (filterTab === 'deferred') return st === 'deferred';
    if (filterTab === 'rejected') return st === 'rejected';
    return true; // 'all'
  });

  const selectedIds = Object.keys(selected).filter(
    (id) => selected[id] && (statuses[id] || 'pending') === 'pending',
  );
  const selectedCount = selectedIds.length;
  const allFilteredPendingSelected =
    filteredActions.length > 0 &&
    filteredActions
      .filter((a) => (statuses[a.id] || 'pending') === 'pending')
      .every((a) => selected[a.id]);

  const toggleSelectAll = () => {
    if (allFilteredPendingSelected) {
      setSelected({});
    } else {
      const next: Record<string, boolean> = {};
      for (const a of filteredActions) {
        if ((statuses[a.id] || 'pending') === 'pending') {
          next[a.id] = true;
        }
      }
      setSelected(next);
    }
  };

  const setActionStatus = (ids: string[], st: ActionStatus) => {
    setStatuses((prev) => {
      const next = { ...prev };
      for (const id of ids) next[id] = st;
      return next;
    });
  };

  const runExecution = (ids: string[]) => {
    if (ids.length === 0) return;
    setActionStatus(ids, 'approved');

    const fakeHash = `${Math.random().toString(16).slice(2, 6)}…${Math.random().toString(16).slice(2, 5)}`;
    setOutcome({
      type: 'info',
      title: `Issued Signed Approval Token for ${ids.length} Action(s)`,
      detail: `Cryptographic approval tokens issued under BR-2 for ${ids.join(', ')}. Karya agent initiated mutating execution.`,
      hash: fakeHash,
      timestamp: new Date().toLocaleTimeString('en-IN'),
    });

    setTimeout(() => {
      setActionStatus(ids, 'executing');
    }, 450);

    setTimeout(() => {
      setActionStatus(ids, 'executed');
    }, 1500);

    setTimeout(() => {
      setActionStatus(ids, 'verified');
      setSelected({});
      const finalHash = `${Math.random().toString(16).slice(2, 6)}…${Math.random().toString(16).slice(2, 5)}`;
      setOutcome({
        type: 'success',
        title: `Remediation Completed & Execution Verified (${ids.length} actions)`,
        detail: `All actions [${ids.join(', ')}] executed with zero lock contention. State changes validated and appended to the immutable audit ledger.`,
        hash: finalHash,
        timestamp: new Date().toLocaleTimeString('en-IN'),
      });
    }, 2800);
  };

  const approveSelected = () => {
    if (selectedIds.length > 0) {
      runExecution(selectedIds);
    }
  };

  const approveAll = () => {
    const ids = pendingActions.map((a) => a.id);
    if (ids.length > 0) {
      runExecution(ids);
    }
  };

  const rejectActions = (ids: string[]) => {
    if (ids.length === 0) return;
    setActionStatus(ids, 'rejected');
    setSelected({});
    setOutcome({
      type: 'rose',
      title: `Remediation Plan Action(s) Rejected (${ids.length})`,
      detail: `Action(s) [${ids.join(', ')}] marked as skipped. Non-execution rationale permanently logged to the audit ledger.`,
      timestamp: new Date().toLocaleTimeString('en-IN'),
    });
  };

  const openDeferModal = (ids: string[]) => {
    if (ids.length === 0) return;
    setDeferringIds(ids);
    setDeferModalOpen(true);
  };

  const confirmDefer = () => {
    if (deferringIds.length === 0) return;
    setActionStatus(deferringIds, 'deferred');
    setDeferNotes((prev) => {
      const next = { ...prev };
      for (const id of deferringIds) {
        next[id] = `${deferReason} · Snoozed for ${deferDuration}`;
      }
      return next;
    });
    setSelected({});
    setDeferModalOpen(false);
    setOutcome({
      type: 'amber',
      title: `Action(s) Deferred (${deferringIds.length})`,
      detail: `[${deferringIds.join(', ')}] snoozed for ${deferDuration}. Reason: "${deferReason}". Reviewers can re-queue anytime.`,
      timestamp: new Date().toLocaleTimeString('en-IN'),
    });
  };

  const reinstateAction = (id: string) => {
    setActionStatus([id], 'pending');
    setOutcome({
      type: 'info',
      title: `Action ${id} Re-queued to Pending`,
      detail: `Returned to the active pending review queue. Ready for dry-run verification and approval.`,
      timestamp: new Date().toLocaleTimeString('en-IN'),
    });
  };

  const riskBadgeStyle = (r: 'LOW' | 'MED' | 'HIGH') => {
    if (r === 'HIGH') return 'bg-[#FCEEEC] text-[#D9534F]';
    if (r === 'MED') return 'bg-[#FBF3DF] text-[#8a6d10]';
    return 'bg-[#E5FAF7] text-[#0a8d80]';
  };

  const statusBadge = (st: ActionStatus) => {
    switch (st) {
      case 'approved':
        return (
          <span className="bg-[#E5FAF7] text-[#0a8d80] px-1.5 py-0.5 rounded text-[8.5px] font-bold">
            APPROVED
          </span>
        );
      case 'executing':
        return (
          <span className="bg-[#FBF3DF] text-[#8a6d10] px-1.5 py-0.5 rounded text-[8.5px] font-bold animate-pulse">
            EXECUTING…
          </span>
        );
      case 'executed':
        return (
          <span className="bg-[#1E2A4A] text-white px-1.5 py-0.5 rounded text-[8.5px] font-bold">
            EXECUTED
          </span>
        );
      case 'verified':
        return (
          <span className="bg-[#0FB5A5] text-white px-1.5 py-0.5 rounded text-[8.5px] font-bold">
            ✓ VERIFIED
          </span>
        );
      case 'rejected':
        return (
          <span className="bg-[#FCEEEC] text-[#D9534F] px-1.5 py-0.5 rounded text-[8.5px] font-bold">
            REJECTED
          </span>
        );
      case 'deferred':
        return (
          <span className="bg-amber-100 text-amber-800 px-1.5 py-0.5 rounded text-[8.5px] font-bold">
            DEFERRED
          </span>
        );
      default:
        return (
          <span className="bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded text-[8.5px] font-bold">
            PENDING
          </span>
        );
    }
  };

  return (
    <div className="mx-auto max-w-[1180px] space-y-4 animate-in fade-in-0 duration-200">
      {/* ============================================================ */}
      {/* 1. HERO BANNER                                               */}
      {/* ============================================================ */}
      <div className="rounded-2xl bg-gradient-to-br from-[#1E2A4A] via-[#1E2A4A] to-[#243356] p-6 md:p-7 text-white shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex-1 min-w-[280px]">
            <div className="mb-2 flex items-center gap-2 flex-wrap">
              <span className="rounded bg-[#0FB5A5] px-2 py-0.5 text-[9px] font-bold text-[#04322d] uppercase tracking-wider">
                P3 · M3.2
              </span>
              <div className="flex flex-wrap items-center gap-1.5 text-xs font-semibold text-[#0FB5A5]">
                <span>Agent ·</span>
                <span className="inline-flex items-center gap-1">
                  <AgentIcon agent="sudhaar" size="xs" variant="on-dark" state="working" />
                  <span>Sudhaar</span>
                </span>
                <span className="text-[#0FB5A5]/70">+</span>
                <span className="inline-flex items-center gap-1">
                  <AgentIcon agent="karya" size="xs" variant="on-dark" state="idle" />
                  <span>Karya</span>
                </span>
              </div>
              <span className="text-xs text-[#8a97b8]">Human Gate (ADR-1)</span>
              <span className="rounded bg-white/10 px-2 py-0.5 font-mono text-[10px] text-[#C9A227]">
                Signed Scope-Bound Tokens
              </span>
            </div>
            <div className="flex items-baseline gap-3">
              <h1 className="font-heading text-2xl md:text-[26px] font-bold text-white tracking-tight">
                Approval Console
              </h1>
              <span className="font-heading text-lg text-[#0FB5A5] font-normal">अनुमोदन कंसोल</span>
            </div>
            <p className="mt-2 max-w-2xl text-xs leading-relaxed text-[#c7cfe0]">
              Every mutating remediation action requires an issued human approval token. Actions
              must complete a verified dry-run and carry deterministic rollbacks before reaching
              this gate (BR-2).
            </p>
          </div>

          {/* Quick Action Buttons */}
          <div className="flex items-center gap-2.5">
            <button
              type="button"
              onClick={approveSelected}
              disabled={selectedCount === 0}
              className={`rounded-[9px] px-4 py-2 text-xs font-bold text-white transition-all shadow-xs ${
                selectedCount > 0
                  ? 'bg-[#0FB5A5] hover:bg-[#0da294] cursor-pointer'
                  : 'bg-white/10 text-white/40 cursor-not-allowed'
              }`}
              title="Approve selected actions with dry-run validated tokens"
            >
              Approve selected ({selectedCount})
            </button>
            <button
              type="button"
              onClick={approveAll}
              disabled={pendingCount === 0}
              className={`rounded-[9px] px-4 py-2 text-xs font-bold text-white transition-all ${
                pendingCount > 0
                  ? 'bg-white/10 hover:bg-white/20 cursor-pointer'
                  : 'bg-white/5 text-white/30 cursor-not-allowed'
              }`}
              title="Approve all eligible pending actions across current plans"
            >
              Approve all pending ({pendingCount})
            </button>
          </div>
        </div>
      </div>

      {/* ============================================================ */}
      {/* OUTCOME BANNER (AUTO-DISMISSING & WITH CRYPTOGRAPHIC HASH)  */}
      {/* ============================================================ */}
      {outcome && (
        <div
          className={`flex items-start justify-between rounded-xl p-4 text-xs shadow-sm transition-all animate-in fade-in-0 duration-200 border ${
            outcome.type === 'success'
              ? 'bg-[#E5FAF7] border-teal-300 text-[#04322d]'
              : outcome.type === 'rose'
                ? 'bg-rose-50 border-rose-200 text-rose-900'
                : outcome.type === 'amber'
                  ? 'bg-amber-50 border-amber-200 text-amber-900'
                  : 'bg-indigo-50 border-indigo-200 text-indigo-900'
          }`}
        >
          <div className="flex items-start gap-3">
            <span className="text-base">
              {outcome.type === 'success'
                ? '✓'
                : outcome.type === 'rose'
                  ? '✕'
                  : outcome.type === 'amber'
                    ? '⏸'
                    : 'ℹ'}
            </span>
            <div>
              <div className="font-bold text-sm tracking-tight">{outcome.title}</div>
              <p className="mt-0.5 text-xs opacity-90 leading-relaxed">{outcome.detail}</p>
              <div className="mt-1.5 flex items-center gap-3 font-mono text-[10px] opacity-75">
                {outcome.hash && <span>Ledger Entry: {outcome.hash}</span>}
                <span>Timestamp: {outcome.timestamp}</span>
              </div>
            </div>
          </div>
          <button
            onClick={() => setOutcome(null)}
            className="text-xs font-bold opacity-60 hover:opacity-100 px-1 py-0.5 cursor-pointer"
            title="Dismiss notification"
          >
            ✕
          </button>
        </div>
      )}

      {/* ============================================================ */}
      {/* 2. MAIN 2-COLUMN CONSOLE                                     */}
      {/* ============================================================ */}
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_420px] gap-4 items-start">
        {/* Left Column: Actions List */}
        <div className="rounded-2xl border border-[#e4e8ee] bg-white overflow-hidden shadow-2xs">
          {/* Header & Filter Tabs */}
          <div className="border-b border-[#e4e8ee] bg-[#F4F6F8]">
            <div className="flex items-center justify-between px-5 py-3 border-b border-slate-200/60">
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={allFilteredPendingSelected}
                  onChange={toggleSelectAll}
                  disabled={filterTab !== 'pending' && filterTab !== 'all'}
                  className="h-3.5 w-3.5 rounded border-slate-300 text-teal-600 focus:ring-teal-500 disabled:opacity-40"
                />
                <span className="font-heading text-xs font-semibold text-[#1E2A4A] uppercase tracking-wider">
                  Remediation Queue
                </span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => rejectActions(selectedIds)}
                  disabled={selectedCount === 0}
                  className="text-[11px] font-semibold text-[#D9534F] hover:underline disabled:opacity-40 cursor-pointer"
                >
                  Reject selected
                </button>
                <span className="text-slate-300">·</span>
                <button
                  type="button"
                  onClick={() => openDeferModal(selectedIds)}
                  disabled={selectedCount === 0}
                  className="text-[11px] font-semibold text-amber-700 hover:underline disabled:opacity-40 cursor-pointer"
                >
                  Defer selected
                </button>
              </div>
            </div>

            {/* Filter Tabs */}
            <div className="flex items-center px-4 py-1.5 gap-2 overflow-x-auto text-xs">
              <button
                type="button"
                onClick={() => setFilterTab('pending')}
                className={`rounded-lg px-2.5 py-1 font-semibold transition-colors ${
                  filterTab === 'pending'
                    ? 'bg-white text-[#1E2A4A] shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Pending ({pendingCount})
              </button>
              <button
                type="button"
                onClick={() => setFilterTab('verified')}
                className={`rounded-lg px-2.5 py-1 font-semibold transition-colors ${
                  filterTab === 'verified'
                    ? 'bg-white text-teal-700 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Approved / Verified ({verifiedCount})
              </button>
              <button
                type="button"
                onClick={() => setFilterTab('deferred')}
                className={`rounded-lg px-2.5 py-1 font-semibold transition-colors ${
                  filterTab === 'deferred'
                    ? 'bg-white text-amber-800 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Deferred ({deferredCount})
              </button>
              <button
                type="button"
                onClick={() => setFilterTab('rejected')}
                className={`rounded-lg px-2.5 py-1 font-semibold transition-colors ${
                  filterTab === 'rejected'
                    ? 'bg-white text-rose-700 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Rejected ({rejectedCount})
              </button>
              <button
                type="button"
                onClick={() => setFilterTab('all')}
                className={`rounded-lg px-2.5 py-1 font-semibold transition-colors ${
                  filterTab === 'all'
                    ? 'bg-white text-slate-800 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                All ({actionsData.length})
              </button>
            </div>
          </div>

          {/* Action List Items */}
          <div className="divide-y divide-[#eef1f5]">
            {filteredActions.length === 0 ? (
              <div className="p-8 text-center text-xs text-slate-500">
                No actions found in this tab.
              </div>
            ) : (
              filteredActions.map((act) => {
                const st = statuses[act.id] || 'pending';
                const isSel = selected[act.id];
                const isCurrent = selId === act.id;

                return (
                  <div
                    key={act.id}
                    onClick={() => setSelId(act.id)}
                    className={`p-4 transition-colors cursor-pointer flex items-start gap-3 ${
                      isCurrent ? 'bg-[#F4F6F8]' : 'hover:bg-slate-50/70'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={!!isSel}
                      disabled={st !== 'pending'}
                      onChange={(e) => {
                        e.stopPropagation();
                        if (st === 'pending') {
                          setSelected((prev) => ({ ...prev, [act.id]: !prev[act.id] }));
                        }
                      }}
                      className="mt-1 h-3.5 w-3.5 rounded border-slate-300 text-teal-600 focus:ring-teal-500 disabled:opacity-30"
                    />

                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <code className="font-mono text-[11px] font-bold text-[#1E2A4A]">
                          {act.id}
                        </code>
                        <span
                          className={`px-1.5 py-0.5 rounded text-[9px] font-bold ${riskBadgeStyle(act.risk)}`}
                        >
                          {act.risk}
                        </span>
                        <span className="font-mono text-[10px] text-slate-400 bg-slate-100 px-1 rounded">
                          {act.type}
                        </span>
                        {statusBadge(st)}
                      </div>

                      <h3 className="mt-1 text-xs font-semibold text-[#2F3542] line-clamp-1">
                        {act.title}
                      </h3>

                      {st === 'deferred' && deferNotes[act.id] && (
                        <div className="mt-1 text-[10.5px] font-medium text-amber-800 bg-amber-50 px-2 py-0.5 rounded border border-amber-200">
                          {deferNotes[act.id]}
                        </div>
                      )}

                      <div className="mt-1 flex items-center gap-3 text-[11px] text-[#8a909b]">
                        <span>Target: {act.target}</span>
                        <span>·</span>
                        <span>Blast: {act.blast.toLocaleString()}</span>
                        <span>·</span>
                        <span className="font-mono text-[10px]">Dry: {act.dryAge}</span>
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Right Column: Selected Action Inspector */}
        {selectedAction && (
          <div className="sticky top-4 space-y-4">
            <div className="rounded-2xl border border-[#e4e8ee] bg-white p-5 shadow-2xs space-y-4">
              <div className="flex items-center justify-between pb-3 border-b border-slate-100">
                <div>
                  <div className="flex items-center gap-2">
                    <code className="font-mono text-xs font-bold text-[#1E2A4A]">
                      {selectedAction.id}
                    </code>
                    <span
                      className={`px-2 py-0.5 rounded text-[10px] font-bold ${riskBadgeStyle(selectedAction.risk)}`}
                    >
                      {selectedAction.risk} RISK
                    </span>
                    {statusBadge(statuses[selectedAction.id] || 'pending')}
                  </div>
                  <h2 className="mt-1 text-sm font-bold text-[#1E2A4A]">{selectedAction.title}</h2>
                </div>
              </div>

              {/* Status Banner */}
              {(statuses[selectedAction.id] === 'verified' ||
                statuses[selectedAction.id] === 'executed') && (
                <div className="rounded-xl border border-teal-300 bg-[#E5FAF7] p-3 text-xs text-[#04322d]">
                  <div className="font-bold flex items-center gap-1.5 text-teal-800">
                    <span>✓</span> Execution Verified in Ledger
                  </div>
                  <p className="mt-0.5 text-[11px] opacity-90">
                    Karya executed this remediation action with zero downtime. Rollback snapshot
                    sealed in ap-south-1 WORM vault.
                  </p>
                </div>
              )}

              {statuses[selectedAction.id] === 'deferred' && (
                <div className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900">
                  <div className="font-bold flex items-center gap-1.5 text-amber-800">
                    <span>⏸</span> Action Currently Deferred
                  </div>
                  <p className="mt-0.5 text-[11px] opacity-90">
                    {deferNotes[selectedAction.id] ||
                      'Action placed on hold pending review window.'}
                  </p>
                </div>
              )}

              {statuses[selectedAction.id] === 'rejected' && (
                <div className="rounded-xl border border-rose-300 bg-rose-50 p-3 text-xs text-rose-900">
                  <div className="font-bold flex items-center gap-1.5 text-rose-800">
                    <span>✕</span> Action Rejected & Skipped
                  </div>
                  <p className="mt-0.5 text-[11px] opacity-90">
                    Non-execution recorded in the audit trail.
                  </p>
                </div>
              )}

              {/* Statutory Citation & Justification */}
              <div>
                <div className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">
                  Statutory Citation
                </div>
                <div className="mt-0.5 font-mono text-xs text-[#1E2A4A]">
                  {selectedAction.citation}
                </div>
                <p className="mt-1 text-xs text-slate-600 leading-relaxed">{selectedAction.why}</p>
              </div>

              {/* Blast Radius Metrics */}
              <div>
                <div className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1.5">
                  Simulated Blast Radius
                </div>
                <div className="grid grid-cols-3 gap-2">
                  {selectedAction.blastCards.map((b, bIdx) => (
                    <div key={bIdx} className="rounded-lg bg-[#F4F6F8] p-2 text-center">
                      <div className="font-mono text-xs font-bold text-[#1E2A4A]">{b.v}</div>
                      <div className="text-[10px] text-[#8a909b]">{b.l}</div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Deterministic Rollback Definition */}
              <div className="rounded-xl border border-teal-200 bg-[#E5FAF7] p-3">
                <div className="flex items-center justify-between">
                  <span className="text-[10.5px] font-bold text-[#0a6b61] uppercase tracking-wider">
                    Validated Rollback Plan
                  </span>
                  <code className="font-mono text-[10px] text-[#0a6b61]">
                    {selectedAction.rollbackRef}
                  </code>
                </div>
                <p className="mt-1 text-[11px] text-[#04322d] leading-normal">
                  {selectedAction.rollback}
                </p>
              </div>

              {/* Dry-Run Simulated State Diff */}
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">
                    Dry-Run Execution Diff
                  </span>
                  <span className="font-mono text-[10px] text-slate-400">
                    H:{selectedAction.dryHash}
                  </span>
                </div>
                <div className="divide-y divide-slate-100 rounded-lg border border-slate-200 bg-slate-50 font-mono text-[10.5px] overflow-hidden">
                  {selectedAction.diff.map((d, dIdx) => (
                    <div key={dIdx} className={`px-2.5 py-1.5 flex items-start gap-1.5 ${d.style}`}>
                      <span className="font-bold shrink-0">{d.sign}</span>
                      <span className="break-all">{d.text}</span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Action Decision Buttons */}
              <div className="pt-2 flex flex-wrap gap-2">
                {(statuses[selectedAction.id] || 'pending') === 'pending' && (
                  <>
                    <button
                      type="button"
                      onClick={() => runExecution([selectedAction.id])}
                      className="flex-1 rounded-[9px] bg-[#0FB5A5] hover:bg-[#0da294] py-2 text-xs font-bold text-white transition-all shadow-xs cursor-pointer"
                    >
                      Approve Action
                    </button>
                    <button
                      type="button"
                      onClick={() => openDeferModal([selectedAction.id])}
                      className="rounded-[9px] border border-amber-300 bg-amber-50 hover:bg-amber-100 px-3 py-2 text-xs font-bold text-amber-800 transition-all cursor-pointer"
                    >
                      Defer
                    </button>
                    <button
                      type="button"
                      onClick={() => rejectActions([selectedAction.id])}
                      className="rounded-[9px] border border-rose-200 bg-rose-50 hover:bg-rose-100 px-3 py-2 text-xs font-bold text-[#D9534F] transition-all cursor-pointer"
                    >
                      Reject
                    </button>
                  </>
                )}

                {statuses[selectedAction.id] === 'deferred' && (
                  <>
                    <button
                      type="button"
                      onClick={() => reinstateAction(selectedAction.id)}
                      className="flex-1 rounded-[9px] border border-teal-300 bg-teal-50 hover:bg-teal-100 py-2 text-xs font-bold text-teal-800 transition-all cursor-pointer"
                    >
                      Re-queue to Pending
                    </button>
                    <button
                      type="button"
                      onClick={() => runExecution([selectedAction.id])}
                      className="rounded-[9px] bg-[#0FB5A5] hover:bg-[#0da294] px-4 py-2 text-xs font-bold text-white transition-all shadow-xs cursor-pointer"
                    >
                      Approve Now
                    </button>
                  </>
                )}

                {statuses[selectedAction.id] === 'rejected' && (
                  <button
                    type="button"
                    onClick={() => reinstateAction(selectedAction.id)}
                    className="w-full rounded-[9px] border border-slate-300 bg-white hover:bg-slate-50 py-2 text-xs font-bold text-slate-700 transition-all cursor-pointer"
                  >
                    Re-evaluate Action (Return to Pending)
                  </button>
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ============================================================ */}
      {/* DEFER MODAL                                                  */}
      {/* ============================================================ */}
      {deferModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 animate-in fade-in-0 duration-150 backdrop-blur-xs overflow-y-auto">
          <div className="relative w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl border border-slate-200 space-y-4 my-8 max-h-[90vh] flex flex-col justify-between">
            <div>
              <div className="flex items-center justify-between pb-2 border-b border-slate-100">
                <div className="flex items-center gap-2">
                  <span className="text-amber-600 text-lg">⏸</span>
                  <h3 className="text-base font-bold text-[#1E2A4A]">
                    Defer Remediation Action ({deferringIds.length})
                  </h3>
                </div>
                <button
                  type="button"
                  onClick={() => setDeferModalOpen(false)}
                  className="text-slate-400 hover:text-slate-600 text-sm font-bold p-1 cursor-pointer"
                >
                  ✕
                </button>
              </div>

              <p className="mt-3 text-xs text-slate-600 leading-relaxed">
                Deferring places the action in a snoozed state. It temporarily suspends automated
                execution without rejecting the remediation finding.
              </p>

              <div className="mt-4 space-y-3">
                <div>
                  <label className="text-xs font-semibold text-slate-700">Deferral Reason</label>
                  <select
                    value={deferReason}
                    onChange={(e) => setDeferReason(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-slate-300 bg-white p-2 text-xs text-slate-800 focus:border-teal-500 focus:outline-none"
                  >
                    <option value="Scheduled for off-peak maintenance window (Saturday 02:00 IST)">
                      Scheduled for off-peak maintenance window (Saturday 02:00 IST)
                    </option>
                    <option value="Awaiting Data Protection Officer (DPO) legal sign-off">
                      Awaiting Data Protection Officer (DPO) legal sign-off
                    </option>
                    <option value="Requires secondary blast-radius staging test">
                      Requires secondary blast-radius staging test
                    </option>
                    <option value="Dependency on upstream core banking / ERP freeze">
                      Dependency on upstream core banking / ERP freeze
                    </option>
                    <option value="Pending statutory filing review under DPDPA Rule 8">
                      Pending statutory filing review under DPDPA Rule 8
                    </option>
                  </select>
                </div>

                <div>
                  <label className="text-xs font-semibold text-slate-700">Deferral Duration</label>
                  <select
                    value={deferDuration}
                    onChange={(e) => setDeferDuration(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-slate-300 bg-white p-2 text-xs text-slate-800 focus:border-teal-500 focus:outline-none"
                  >
                    <option value="24 Hours">24 Hours (Next Day Review)</option>
                    <option value="72 Hours">72 Hours (Weekend Window)</option>
                    <option value="7 Days">7 Days (Next Compliance Sprint)</option>
                    <option value="Until Next Board Meeting">Until Next Board Meeting</option>
                  </select>
                </div>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2.5 pt-3 border-t border-slate-100 mt-2">
              <button
                type="button"
                onClick={() => setDeferModalOpen(false)}
                className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 transition-colors cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={confirmDefer}
                className="rounded-lg bg-amber-600 hover:bg-amber-700 px-4 py-2 text-xs font-bold text-white shadow-xs transition-colors cursor-pointer flex items-center gap-1.5"
              >
                <span>⏸</span>
                <span>Confirm Deferral ({deferringIds.length})</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
