'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { AgentIcon } from '@axiom/ui';

export interface TenantSummary {
  id: string;
  name: string;
  slug: string;
  tier?: string;
  is_sdf?: boolean;
}

export interface EngagementSummary {
  id: string;
  title: string;
  status: string;
  /** Persisted engagement posture; null until an assessment has scored it. */
  postureScore: number | null;
  /** Persisted exposure estimate; null when none was recorded. */
  estimatedExposureInr: number | null;
  startedAt?: string;
  /** Saved-results bands from the BFF projection (not a legal determination). */
  summary: { pass: number; partial: number; fail: number; unassessed: number };
  totalControls: number;
}

export interface PlanActionSummary {
  id: string;
  description: string;
  actionType: string;
  riskClass: string;
  blastRadius: any;
  approvalStatus: string;
}

export interface PlanSummary {
  id: string;
  title: string;
  status: string;
  version: number;
  generatedByAgent: string;
  createdAt: string;
  actions: PlanActionSummary[];
}

export interface EvidenceSummary {
  id: string;
  contentHash: string;
  storageUri: string;
  evidenceType: string;
  description: string;
  collectedByAgent: string;
  collectedAt: string;
  demonstratesControlIds: string[];
}

export interface DsarSummary {
  id: string;
  kind: string;
  status: string;
  principalName: string;
  dueBy: string | null;
  receivedAt: string;
  /** Days until the recorded due date; null when no due date is recorded. */
  slaDays: number | null;
}

export interface BreachSummary {
  id: string;
  title: string;
  status: string;
  severity: string;
  dpbNotificationDueBy?: string;
  occurredAt?: string;
  affectedCount?: number;
}

export interface LedgerSummary {
  sequenceNo: number;
  actorId: string;
  actionType: string;
  result: string;
  targetRef?: string;
  entryHash: string;
  occurredAt: string;
}

export interface PortalClientProps {
  tenants: TenantSummary[];
  activeTenant: TenantSummary;
  engagement: EngagementSummary | null;
  plans: PlanSummary[];
  evidence: EvidenceSummary[];
  dsars: DsarSummary[];
  breaches: BreachSummary[];
  ledger: LedgerSummary[];
  /** The saved-results projection could not be read. */
  assessmentUnavailable: boolean;
  /** At least one portal query failed; shown lists may be incomplete. */
  loadError: boolean;
}

type TabType = 'overview' | 'approvals' | 'evidence' | 'dsars' | 'ledger';

export function PortalClient({
  tenants,
  activeTenant,
  engagement,
  plans,
  evidence,
  dsars,
  breaches,
  ledger,
  assessmentUnavailable,
  loadError,
}: PortalClientProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [activeTab, setActiveTab] = useState<TabType>('overview');
  const [copiedHash, setCopiedHash] = useState<string | null>(null);

  const handleTenantChange = (slug: string) => {
    document.cookie = `axiom_active_tenant=${slug}; path=/; max-age=31536000; SameSite=Lax`;
    const params = new URLSearchParams(searchParams.toString());
    params.set('tenant', slug);
    router.push(`/portal?${params.toString()}`);
  };

  const copyHash = (hash: string) => {
    navigator.clipboard.writeText(hash);
    setCopiedHash(hash);
    setTimeout(() => setCopiedHash(null), 2000);
  };

  // C-W0-7: only persisted values are shown; missing values render as such.
  const postureScore = engagement?.postureScore ?? null;
  const exposureInr = engagement?.estimatedExposureInr ?? null;
  const exposureDisplay =
    exposureInr === null
      ? 'Not recorded'
      : exposureInr >= 10000000
        ? `₹${(exposureInr / 10000000).toFixed(1)} Cr`
        : `₹${exposureInr.toLocaleString('en-IN')}`;

  const passingControls = engagement?.summary.pass ?? 0;
  const assessedControls = engagement
    ? engagement.summary.pass + engagement.summary.partial + engagement.summary.fail
    : 0;
  const totalControls = engagement?.totalControls ?? 0;
  const passingPct = totalControls ? Math.round((passingControls / totalControls) * 100) : 0;
  const nearingSla = dsars.filter(
    (d) => d.slaDays !== null && d.slaDays <= 3 && !['completed', 'rejected'].includes(d.status),
  ).length;
  const openBreaches = breaches.filter((b) => b.status !== 'closed').length;

  const pendingPlanCount = plans.filter(
    (p) => p.status === 'review' || p.status === 'draft',
  ).length;
  const totalActionsCount = plans.reduce((acc, p) => acc + (p.actions?.length || 0), 0);
  const openDsarCount = dsars.filter(
    (d) => d.status !== 'completed' && d.status !== 'rejected',
  ).length;

  return (
    <div className="mx-auto max-w-[1240px] space-y-6 animate-in fade-in-0 duration-200">
      {/* ============================================================ */}
      {/* 1. HERO BANNER                                               */}
      {/* ============================================================ */}
      <div className="rounded-2xl bg-gradient-to-br from-[#1E2A4A] via-[#1E2A4A] to-[#243356] p-6 md:p-7 text-white shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex-1 min-w-[280px]">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <span className="rounded bg-[#0FB5A5] px-2 py-0.5 text-[9px] font-bold text-[#04322d] uppercase tracking-wider">
                P4 · M4.7
              </span>
              <div className="flex flex-wrap items-center gap-1.5 text-xs font-semibold text-[#0FB5A5]">
                <span>Agent ·</span>
                <span className="inline-flex items-center gap-1">
                  <AgentIcon agent="saakshi" size="xs" variant="on-dark" state="working" />
                  <span>Saakshi</span>
                </span>
                <span className="text-[#0FB5A5]/70">+</span>
                <span className="inline-flex items-center gap-1">
                  <AgentIcon agent="sudhaar" size="xs" variant="on-dark" state="idle" />
                  <span>Sudhaar</span>
                </span>
              </div>
              <span className="text-xs text-[#8a97b8]">Autonomy L1 — Agent-Proposes</span>
              <span className="rounded bg-white/10 px-2 py-0.5 font-mono text-[10px] text-[#C9A227]">
                DPDPA §8(2) & §6 Client Portal
              </span>
            </div>

            <div className="flex items-baseline gap-3">
              <h1 className="font-heading text-2xl md:text-[26px] font-bold text-white tracking-tight">
                Client Portal
              </h1>
              <span className="font-heading text-lg text-[#0FB5A5] font-normal">ग्राहक पोर्टल</span>
            </div>

            <p className="mt-2 max-w-3xl text-xs leading-relaxed text-[#c7cfe0]">
              Tenant-scoped executive portal for client leadership, compliance officers, and
              statutory auditors. Real-time posture surveillance, cryptographic evidence
              verification, and safe human-in-the-loop approvals.
            </p>
          </div>

          {/* Tenant Selector & Actions */}
          <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3">
            <div className="flex items-center gap-2 rounded-xl border border-white/15 bg-white/5 px-3 py-2 text-xs">
              <span className="text-[#8a97b8]">Organization:</span>
              {tenants.length > 1 ? (
                <select
                  value={activeTenant.slug}
                  onChange={(e) => handleTenantChange(e.target.value)}
                  className="bg-transparent font-medium text-white outline-none cursor-pointer focus:ring-0"
                >
                  {tenants.map((t) => (
                    <option key={t.id} value={t.slug} className="bg-[#1E2A4A] text-white">
                      {t.name}
                    </option>
                  ))}
                </select>
              ) : (
                <span className="font-semibold text-white">{activeTenant.name}</span>
              )}
            </div>

            <Link
              href="/approval"
              className="rounded-[9px] bg-[#0FB5A5] hover:bg-[#0da294] text-white text-xs font-bold py-2.5 px-4 shadow-sm transition-all text-center"
            >
              Approval Console →
            </Link>
          </div>
        </div>

        {/* Status Bar */}
        <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-white/10 pt-4 text-xs">
          <div className="flex flex-wrap items-center gap-4 text-[#c7cfe0]">
            <span className="inline-flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-[#0FB5A5] animate-pulse" />
              <span className="font-medium text-white">Recorded data</span>
            </span>
            <span>·</span>
            <span>
              Residency: <strong className="text-white">ap-south-1 (Mumbai)</strong>
            </span>
            <span>·</span>
            <span>
              Tenant Tier:{' '}
              <strong className="text-[#0FB5A5] capitalize">
                {activeTenant.tier || 'Not set'}
              </strong>
            </span>
            {activeTenant.is_sdf && (
              <>
                <span>·</span>
                <span className="rounded bg-[#C9A227]/20 px-2 py-0.5 text-[10px] font-semibold text-[#C9A227]">
                  SDF Classified
                </span>
              </>
            )}
          </div>

          <div className="text-[11px] font-mono text-[#8a97b8]">
            Tenant ID:{' '}
            <span className="text-white">
              {activeTenant.id.slice(0, 8)}…{activeTenant.id.slice(-4)}
            </span>
          </div>
        </div>
      </div>

      {loadError && (
        <div
          role="alert"
          className="rounded-xl border border-[#D9534F]/30 bg-[#D9534F]/5 px-4 py-3 text-xs text-[#9b2c2c]"
        >
          Some portal data could not be loaded. Lists below may be incomplete; nothing has been
          substituted.
        </div>
      )}

      {/* ============================================================ */}
      {/* 2. DYNAMIC KPI STAT CARDS                                    */}
      {/* ============================================================ */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        {/* Posture Score */}
        <div className="rounded-2xl border border-[#e4e8ee] bg-white p-4 shadow-2xs">
          <div className="text-[11px] font-medium text-[#64748b] uppercase tracking-wider">
            Compliance Posture
          </div>
          <div className="mt-2 flex items-baseline gap-1.5">
            <span
              className="font-heading text-2xl font-bold text-[#1E2A4A]"
              data-testid="portal-posture"
            >
              {postureScore === null ? '—' : Math.round(postureScore)}
            </span>
            {postureScore !== null && <span className="text-xs text-[#94a3b8]">/100</span>}
          </div>
          <div className="mt-2 text-[11px] text-[#64748b]">
            {postureScore === null ? 'Not yet assessed' : 'Latest saved assessment'}
          </div>
        </div>

        {/* Statutory Exposure */}
        <div className="rounded-2xl border border-[#e4e8ee] bg-white p-4 shadow-2xs">
          <div className="text-[11px] font-medium text-[#64748b] uppercase tracking-wider">
            Estimated Exposure
          </div>
          <div className="mt-2 font-heading text-xl font-bold text-[#D9534F] tracking-tight">
            {exposureDisplay}
          </div>
          <div className="mt-2 text-[11px] text-[#64748b]">
            {exposureInr === null ? 'No saved estimate' : 'Saved estimate'}
          </div>
        </div>

        {/* Controls Passing */}
        <div className="rounded-2xl border border-[#e4e8ee] bg-white p-4 shadow-2xs">
          <div className="text-[11px] font-medium text-[#64748b] uppercase tracking-wider">
            Controls Passing
          </div>
          <div className="mt-2 flex items-baseline gap-1.5">
            <span
              className="font-heading text-2xl font-bold text-[#0FB5A5]"
              data-testid="portal-controls-passing"
            >
              {engagement ? passingControls : '—'}
            </span>
            {engagement && <span className="text-xs text-[#94a3b8]">/{totalControls}</span>}
          </div>
          <div className="mt-2 text-[11px] text-[#64748b]">
            {engagement
              ? `${assessedControls} of ${totalControls} assessed`
              : 'No saved assessment'}
          </div>
        </div>

        {/* Pending Approvals */}
        <div className="rounded-2xl border border-[#e4e8ee] bg-white p-4 shadow-2xs">
          <div className="text-[11px] font-medium text-[#64748b] uppercase tracking-wider">
            Pending Approvals
          </div>
          <div className="mt-2 flex items-baseline gap-1.5">
            <span className="font-heading text-2xl font-bold text-[#C9A227]">
              {pendingPlanCount}
            </span>
            <span className="text-xs text-[#94a3b8]">plans</span>
          </div>
          <div className="mt-2 text-[11px] text-[#64748b]">{totalActionsCount} actions drafted</div>
        </div>

        {/* Sealed Evidence */}
        <div className="rounded-2xl border border-[#e4e8ee] bg-white p-4 shadow-2xs">
          <div className="text-[11px] font-medium text-[#64748b] uppercase tracking-wider">
            Sealed Proofs
          </div>
          <div className="mt-2 font-heading text-2xl font-bold text-[#1E2A4A]">
            {evidence.length}
          </div>
          <div className="mt-2 text-[11px] text-[#64748b]">Recorded evidence items</div>
        </div>

        {/* Open DSARs */}
        <div className="rounded-2xl border border-[#e4e8ee] bg-white p-4 shadow-2xs">
          <div className="text-[11px] font-medium text-[#64748b] uppercase tracking-wider">
            Active DSARs
          </div>
          <div className="mt-2 font-heading text-2xl font-bold text-[#1E2A4A]">{openDsarCount}</div>
          <div className="mt-2 text-[11px] text-[#64748b]">
            {nearingSla > 0 ? (
              <span className="text-[#D9534F] font-semibold">{nearingSla} due within 3 days</span>
            ) : (
              <span>None due within 3 days</span>
            )}
          </div>
        </div>
      </div>

      {/* ============================================================ */}
      {/* 3. NAVIGATION TABS                                           */}
      {/* ============================================================ */}
      <div className="flex border-b border-[#e4e8ee] gap-2 overflow-x-auto pb-1">
        <button
          type="button"
          onClick={() => setActiveTab('overview')}
          className={`px-4 py-2.5 text-xs font-semibold rounded-t-lg transition-all border-b-2 flex items-center gap-2 ${
            activeTab === 'overview'
              ? 'border-[#0FB5A5] text-[#1E2A4A] bg-white shadow-2xs'
              : 'border-transparent text-[#64748b] hover:text-[#1E2A4A] hover:bg-slate-50'
          }`}
        >
          <span>Compliance Posture & Engagement</span>
        </button>

        <button
          type="button"
          onClick={() => setActiveTab('approvals')}
          className={`px-4 py-2.5 text-xs font-semibold rounded-t-lg transition-all border-b-2 flex items-center gap-2 ${
            activeTab === 'approvals'
              ? 'border-[#0FB5A5] text-[#1E2A4A] bg-white shadow-2xs'
              : 'border-transparent text-[#64748b] hover:text-[#1E2A4A] hover:bg-slate-50'
          }`}
        >
          <span>Pending Approvals</span>
          {pendingPlanCount > 0 && (
            <span className="rounded-full bg-[#C9A227]/20 text-[#856711] px-1.5 py-0.2 font-mono text-[10px]">
              {pendingPlanCount}
            </span>
          )}
        </button>

        <button
          type="button"
          onClick={() => setActiveTab('evidence')}
          className={`px-4 py-2.5 text-xs font-semibold rounded-t-lg transition-all border-b-2 flex items-center gap-2 ${
            activeTab === 'evidence'
              ? 'border-[#0FB5A5] text-[#1E2A4A] bg-white shadow-2xs'
              : 'border-transparent text-[#64748b] hover:text-[#1E2A4A] hover:bg-slate-50'
          }`}
        >
          <span>Sealed Evidence Vault</span>
          <span className="rounded-full bg-slate-100 text-slate-700 px-1.5 py-0.2 font-mono text-[10px]">
            {evidence.length}
          </span>
        </button>

        <button
          type="button"
          onClick={() => setActiveTab('dsars')}
          className={`px-4 py-2.5 text-xs font-semibold rounded-t-lg transition-all border-b-2 flex items-center gap-2 ${
            activeTab === 'dsars'
              ? 'border-[#0FB5A5] text-[#1E2A4A] bg-white shadow-2xs'
              : 'border-transparent text-[#64748b] hover:text-[#1E2A4A] hover:bg-slate-50'
          }`}
        >
          <span>Rights Requests (DSAR)</span>
          <span className="rounded-full bg-slate-100 text-slate-700 px-1.5 py-0.2 font-mono text-[10px]">
            {dsars.length}
          </span>
        </button>

        <button
          type="button"
          onClick={() => setActiveTab('ledger')}
          className={`px-4 py-2.5 text-xs font-semibold rounded-t-lg transition-all border-b-2 flex items-center gap-2 ${
            activeTab === 'ledger'
              ? 'border-[#0FB5A5] text-[#1E2A4A] bg-white shadow-2xs'
              : 'border-transparent text-[#64748b] hover:text-[#1E2A4A] hover:bg-slate-50'
          }`}
        >
          <span>Audit Ledger Stream</span>
          <span className="rounded-full bg-slate-100 text-slate-700 px-1.5 py-0.2 font-mono text-[10px]">
            {ledger.length}
          </span>
        </button>
      </div>

      {/* ============================================================ */}
      {/* 4. TAB CONTENTS                                              */}
      {/* ============================================================ */}

      {/* ---------------- OVERVIEW TAB ---------------- */}
      {activeTab === 'overview' && (
        <div className="space-y-6">
          {/* Current Engagement Card */}
          {engagement ? (
            <div className="rounded-2xl border border-[#e4e8ee] bg-white p-6 shadow-2xs">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="rounded-full bg-[#0FB5A5]/10 text-[#0a7a6f] px-2.5 py-0.5 text-xs font-semibold">
                      Active Statutory Engagement
                    </span>
                    <span className="text-xs text-[#94a3b8]">
                      Started:{' '}
                      {engagement.startedAt
                        ? new Date(engagement.startedAt).toLocaleDateString('en-IN', {
                            day: 'numeric',
                            month: 'short',
                            year: 'numeric',
                          })
                        : 'Live'}
                    </span>
                  </div>
                  <h2 className="mt-2 font-heading text-xl font-bold text-[#1E2A4A]">
                    {engagement.title}
                  </h2>
                  <p className="mt-1 text-xs text-[#64748b] max-w-2xl">
                    Full statutory readiness scope across DPDPA 2023 provisions: Notice & Consent
                    (§5-6), Purpose Limitation (§7), Reasonable Security Safeguards (§8(5)), and
                    Data Principal Rights (§11-14).
                  </p>
                </div>

                <div className="flex items-center gap-4 bg-slate-50 border border-slate-200 rounded-xl p-4">
                  <div>
                    <div className="text-[10px] uppercase font-bold text-[#64748b]">
                      Readiness Status
                    </div>
                    <div className="text-sm font-semibold text-[#1E2A4A] capitalize">
                      {engagement.status}
                    </div>
                  </div>
                  <div className="h-8 w-px bg-slate-200" />
                  <div>
                    <div className="text-[10px] uppercase font-bold text-[#64748b]">
                      Passing Ratio
                    </div>
                    <div className="text-sm font-bold text-[#0FB5A5]">
                      {passingPct}% in pass band
                    </div>
                  </div>
                </div>
              </div>

              {/* Progress Bar */}
              <div className="mt-5 space-y-2">
                <div className="flex justify-between text-xs font-medium text-[#1E2A4A]">
                  <span>Controls in the pass band</span>
                  <span>
                    {passingControls} of {totalControls} ({engagement.summary.unassessed}{' '}
                    unassessed)
                  </span>
                </div>
                <div className="h-2.5 w-full rounded-full bg-slate-100 overflow-hidden">
                  <div
                    className="h-full rounded-full bg-[#0FB5A5] transition-all duration-500"
                    style={{ width: `${passingPct}%` }}
                  />
                </div>
              </div>

              {/* Quick Links inside Engagement */}
              <div className="mt-6 grid grid-cols-1 sm:grid-cols-3 gap-3 pt-4 border-t border-[#eef1f5]">
                <Link
                  href="/assessment"
                  className="rounded-xl border border-slate-200 p-3 hover:border-[#0FB5A5] hover:bg-teal-50/20 transition-all flex items-center justify-between"
                >
                  <div>
                    <div className="text-xs font-semibold text-[#1E2A4A]">Assessment Pipeline</div>
                    <div className="text-[11px] text-slate-500">Parikshan gap telemetry</div>
                  </div>
                  <span className="text-[#0FB5A5] text-xs font-bold">View →</span>
                </Link>

                <Link
                  href="/controls"
                  className="rounded-xl border border-slate-200 p-3 hover:border-[#0FB5A5] hover:bg-teal-50/20 transition-all flex items-center justify-between"
                >
                  <div>
                    <div className="text-xs font-semibold text-[#1E2A4A]">Control Library</div>
                    <div className="text-[11px] text-slate-500">Published control library</div>
                  </div>
                  <span className="text-[#0FB5A5] text-xs font-bold">View →</span>
                </Link>

                <Link
                  href="/reports"
                  className="rounded-xl border border-slate-200 p-3 hover:border-[#0FB5A5] hover:bg-teal-50/20 transition-all flex items-center justify-between"
                >
                  <div>
                    <div className="text-xs font-semibold text-[#1E2A4A]">
                      Executive Report Pack
                    </div>
                    <div className="text-[11px] text-slate-500">Board & DPB attestations</div>
                  </div>
                  <span className="text-[#0FB5A5] text-xs font-bold">View →</span>
                </Link>
              </div>
            </div>
          ) : (
            <div
              className="rounded-2xl border border-dashed border-slate-200 bg-white p-8 text-center text-slate-500"
              data-testid="portal-no-engagement"
            >
              {assessmentUnavailable
                ? 'Saved assessment results are unavailable right now. Try again.'
                : 'No assessment engagement recorded for this organization.'}
            </div>
          )}

          {/* Breaches & Incidents Safe Radar */}
          <div className="rounded-2xl border border-[#e4e8ee] bg-white p-5 shadow-2xs">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <span className="h-2.5 w-2.5 rounded-full bg-[#0FB5A5]" />
                <h3 className="font-heading text-sm font-semibold text-[#1E2A4A]">
                  Active Security Incidents & CERT-In / DPB Radar
                </h3>
              </div>
              <span className="rounded bg-slate-50 text-slate-700 px-2 py-0.5 text-xs font-semibold border border-slate-200">
                {openBreaches} open of {breaches.length} recorded
              </span>
            </div>
            <p className="mt-2 text-xs text-slate-600">
              {breaches.length === 0
                ? 'No personal data breaches are recorded for this organization.'
                : 'Recorded breaches for this organization; see the Breaches module for details.'}
            </p>
          </div>
        </div>
      )}

      {/* ---------------- APPROVALS TAB ---------------- */}
      {activeTab === 'approvals' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="font-heading text-base font-bold text-[#1E2A4A]">
                Pending Remediation Plans ({plans.length})
              </h2>
              <p className="text-xs text-[#64748b]">
                Remediation plans recorded for this organization. Execution requires a human
                approval backed by a completed dry-run and a validated rollback.
              </p>
            </div>
            <Link href="/approval" className="text-xs font-bold text-[#0FB5A5] hover:underline">
              Open Full Approval Console →
            </Link>
          </div>

          {plans.length === 0 ? (
            <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center text-slate-500">
              No pending remediation plans awaiting review.
            </div>
          ) : (
            plans.map((plan) => (
              <div
                key={plan.id}
                className="rounded-2xl border border-[#e4e8ee] bg-white p-5 shadow-2xs space-y-4"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="rounded bg-[#C9A227]/20 text-[#856711] px-2 py-0.5 text-[11px] font-bold uppercase">
                        {plan.status}
                      </span>
                      <span className="text-xs text-slate-500 font-mono">v{plan.version}</span>
                      <span className="text-xs text-slate-400">·</span>
                      <div className="flex items-center gap-1 text-xs text-slate-600">
                        <span>Agent:</span>
                        <AgentIcon agent={plan.generatedByAgent} size="xs" variant="default" />
                        <span className="font-medium capitalize">{plan.generatedByAgent}</span>
                      </div>
                    </div>
                    <h3 className="mt-1.5 font-heading text-base font-bold text-[#1E2A4A]">
                      {plan.title}
                    </h3>
                  </div>

                  <Link
                    href={`/approval?plan=${plan.id}`}
                    className="rounded-lg bg-[#0FB5A5] hover:bg-[#0da294] text-white text-xs font-bold px-3 py-1.5 transition-all"
                  >
                    Review & Sign →
                  </Link>
                </div>

                {/* Actions List */}
                {plan.actions && plan.actions.length > 0 && (
                  <div className="mt-3 space-y-2 pt-3 border-t border-slate-100">
                    <div className="text-[11px] font-bold uppercase tracking-wider text-slate-500">
                      Drafted Actions ({plan.actions.length})
                    </div>
                    <div className="divide-y divide-slate-100 border border-slate-200 rounded-xl overflow-hidden">
                      {plan.actions.map((act, idx) => (
                        <div
                          key={act.id || idx}
                          className="p-3 bg-white flex flex-wrap items-center justify-between gap-3 text-xs"
                        >
                          <div className="flex items-start gap-2.5 flex-1 min-w-[260px]">
                            <span className="font-mono text-[10px] text-slate-400 mt-0.5">
                              #{idx + 1}
                            </span>
                            <div>
                              <p className="font-medium text-[#1E2A4A]">{act.description}</p>
                              <div className="mt-1 flex items-center gap-2 text-[11px] text-slate-500">
                                <span className="font-mono">{act.actionType}</span>
                                <span>·</span>
                                <span>
                                  Blast radius:{' '}
                                  {act.blastRadius?.rows
                                    ? `${act.blastRadius.rows.toLocaleString()} rows`
                                    : act.blastRadius?.endpoints
                                      ? `${act.blastRadius.endpoints} endpoints`
                                      : 'Scoped'}
                                </span>
                              </div>
                            </div>
                          </div>

                          <div className="flex items-center gap-2">
                            <span
                              className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${
                                act.riskClass === 'high'
                                  ? 'bg-rose-50 text-rose-700 border border-rose-200'
                                  : act.riskClass === 'medium'
                                    ? 'bg-amber-50 text-amber-700 border border-amber-200'
                                    : 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                              }`}
                            >
                              {act.riskClass} Risk
                            </span>
                            <span className="text-[11px] font-medium text-slate-500 capitalize">
                              {act.approvalStatus.replace('_', ' ')}
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      )}

      {/* ---------------- EVIDENCE TAB ---------------- */}
      {activeTab === 'evidence' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="font-heading text-base font-bold text-[#1E2A4A]">
                Cryptographic Evidence Vault ({evidence.length})
              </h2>
              <p className="text-xs text-[#64748b]">
                Immutable proofs sealed with SHA-256 and protected by AWS S3 Object Lock in
                ap-south-1.
              </p>
            </div>
            <Link href="/evidence" className="text-xs font-bold text-[#0FB5A5] hover:underline">
              Open Evidence Console →
            </Link>
          </div>

          {evidence.length === 0 ? (
            <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center text-slate-500">
              No sealed evidence items on record.
            </div>
          ) : (
            <div className="divide-y divide-[#eef1f5] rounded-2xl border border-[#e4e8ee] bg-white shadow-2xs overflow-hidden">
              {evidence.map((item) => (
                <div key={item.id} className="p-4 hover:bg-slate-50 transition-colors">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="flex-1 min-w-[280px]">
                      <div className="flex items-center gap-2">
                        <span className="rounded bg-[#1E2A4A] text-white px-2 py-0.5 text-[10px] font-mono font-bold uppercase tracking-wider">
                          {item.evidenceType}
                        </span>
                        <div className="flex items-center gap-1 text-xs text-slate-600">
                          <span>Sealed by</span>
                          <AgentIcon
                            agent={item.collectedByAgent || 'saakshi'}
                            size="xs"
                            variant="default"
                          />
                          <span className="font-medium capitalize">
                            {item.collectedByAgent || 'Saakshi'}
                          </span>
                        </div>
                        <span className="text-xs text-slate-400">·</span>
                        <span className="text-xs text-slate-500">
                          {item.collectedAt
                            ? new Date(item.collectedAt).toLocaleDateString('en-IN', {
                                day: 'numeric',
                                month: 'short',
                                year: 'numeric',
                              })
                            : 'Recent'}
                        </span>
                      </div>

                      <h4 className="mt-2 text-sm font-semibold text-[#1E2A4A]">
                        {item.description}
                      </h4>

                      {item.demonstratesControlIds && item.demonstratesControlIds.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {item.demonstratesControlIds.map((cid) => (
                            <span
                              key={cid}
                              className="rounded bg-slate-100 text-slate-700 px-1.5 py-0.5 font-mono text-[10px]"
                            >
                              {cid}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>

                    <div className="flex flex-col items-end gap-1.5">
                      <div className="flex items-center gap-1.5 bg-slate-100 px-2.5 py-1 rounded-lg border border-slate-200">
                        <span className="text-[11px] font-mono text-slate-700">
                          {item.contentHash
                            ? `${item.contentHash.slice(0, 8)}…${item.contentHash.slice(-6)}`
                            : 'sha256'}
                        </span>
                        <button
                          type="button"
                          onClick={() => copyHash(item.contentHash)}
                          className="text-[10px] text-[#0FB5A5] hover:underline font-medium"
                        >
                          {copiedHash === item.contentHash ? 'Copied!' : 'Copy'}
                        </button>
                      </div>
                      <span className="text-[10px] font-mono text-slate-400">
                        {item.storageUri
                          ? item.storageUri.replace(
                              's3://axiom-evidence-prod-ap-south-1/',
                              's3://…/',
                            )
                          : 's3://evidence-vault'}
                      </span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ---------------- DSARS TAB ---------------- */}
      {activeTab === 'dsars' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="font-heading text-base font-bold text-[#1E2A4A]">
                Data Principal Rights Requests ({dsars.length})
              </h2>
              <p className="text-xs text-[#64748b]">
                Under DPDPA §11-14: Access, Correction, Erasure, and Grievance Redressal workflows
                with statutory SLA tracking.
              </p>
            </div>
            <Link href="/dsars" className="text-xs font-bold text-[#0FB5A5] hover:underline">
              Open DSAR Console →
            </Link>
          </div>

          {dsars.length === 0 ? (
            <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center text-slate-500">
              No data principal requests on record.
            </div>
          ) : (
            <div className="divide-y divide-[#eef1f5] rounded-2xl border border-[#e4e8ee] bg-white shadow-2xs overflow-hidden">
              {dsars.map((d) => (
                <div
                  key={d.id}
                  className="p-4 flex flex-wrap items-center justify-between gap-3 text-xs"
                >
                  <div className="flex items-center gap-3">
                    <span
                      className={`px-2.5 py-1 rounded-full font-bold uppercase text-[10px] ${
                        d.kind === 'erasure'
                          ? 'bg-rose-50 text-rose-700 border border-rose-200'
                          : d.kind === 'access'
                            ? 'bg-blue-50 text-blue-700 border border-blue-200'
                            : d.kind === 'correction'
                              ? 'bg-amber-50 text-amber-700 border border-amber-200'
                              : 'bg-teal-50 text-teal-700 border border-teal-200'
                      }`}
                    >
                      {d.kind}
                    </span>

                    <div>
                      <div className="font-semibold text-[#1E2A4A]">{d.principalName}</div>
                      <div className="text-[11px] text-slate-500">
                        Received:{' '}
                        {d.receivedAt
                          ? new Date(d.receivedAt).toLocaleDateString('en-IN')
                          : 'Recent'}
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-4">
                    <span className="rounded bg-slate-100 px-2.5 py-0.5 text-[11px] font-medium text-slate-700 capitalize">
                      {d.status.replace('_', ' ')}
                    </span>

                    <div className="text-right">
                      <div className="text-[11px] font-semibold text-[#1E2A4A]">
                        {d.dueBy
                          ? `Due ${new Date(d.dueBy).toLocaleDateString('en-IN')}`
                          : 'No due date recorded'}
                      </div>
                      <div className="text-[10px] text-slate-500">
                        {d.slaDays === null
                          ? '—'
                          : d.slaDays > 0
                            ? `${d.slaDays} days remaining`
                            : 'Due date reached'}
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ---------------- AUDIT LEDGER TAB ---------------- */}
      {activeTab === 'ledger' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="font-heading text-base font-bold text-[#1E2A4A]">
                Immutable Audit Trail ({ledger.length} Recent Events)
              </h2>
              <p className="text-xs text-[#64748b]">
                Append-only PostgreSQL cryptographic ledger with SHA-256 chaining.
              </p>
            </div>
            <Link href="/ledger" className="text-xs font-bold text-[#0FB5A5] hover:underline">
              Open Full Audit Ledger →
            </Link>
          </div>

          {ledger.length === 0 ? (
            <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center text-slate-500">
              No ledger activity recorded for this tenant.
            </div>
          ) : (
            <div className="divide-y divide-[#eef1f5] rounded-2xl border border-[#e4e8ee] bg-white shadow-2xs overflow-hidden">
              {ledger.map((entry) => (
                <div
                  key={entry.sequenceNo}
                  className="p-3.5 flex flex-wrap items-center justify-between gap-3 text-xs"
                >
                  <div className="flex items-center gap-3">
                    <span className="font-mono text-xs font-bold text-[#1E2A4A] bg-slate-100 px-2 py-0.5 rounded">
                      #{entry.sequenceNo}
                    </span>

                    <div className="flex items-center gap-1.5">
                      <AgentIcon agent={entry.actorId} size="xs" variant="default" />
                      <span className="font-semibold capitalize text-[#1E2A4A]">
                        {entry.actorId}
                      </span>
                    </div>

                    <span className="text-slate-400">·</span>
                    <span className="font-mono text-slate-700">{entry.actionType}</span>
                  </div>

                  <div className="flex items-center gap-3">
                    <span
                      className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${
                        entry.result === 'success'
                          ? 'bg-emerald-50 text-emerald-700'
                          : 'bg-slate-100 text-slate-600'
                      }`}
                    >
                      {entry.result}
                    </span>

                    <span className="font-mono text-[10px] text-slate-400">
                      {entry.entryHash
                        ? `${entry.entryHash.slice(0, 6)}…${entry.entryHash.slice(-4)}`
                        : ''}
                    </span>

                    <span className="text-[11px] text-slate-500">
                      {entry.occurredAt
                        ? new Date(entry.occurredAt).toLocaleTimeString('en-IN', {
                            hour: '2-digit',
                            minute: '2-digit',
                          })
                        : ''}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
