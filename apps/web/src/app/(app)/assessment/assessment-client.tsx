'use client';

import React, { useState, useRef } from 'react';
import { invokeAgent, AgentInvocationError } from '@/lib/invoke-agent';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AgentIcon } from '@axiom/ui';
import type { AgentName, AssessmentSnapshot } from '@axiom/types';

export interface AssessmentClientProps {
  snapshot: AssessmentSnapshot | null;
}

export interface PipelineStage {
  agent: string;
  agentKey: AgentName;
  label: string;
  hi: string;
  detail: string;
}

export const PIPELINE_STAGES: PipelineStage[] = [
  {
    agent: 'Drishti',
    agentKey: 'drishti',
    label: 'Discovery',
    hi: 'खोज',
    detail: 'sweeping estate for personal data',
  },
  {
    agent: 'Vibhaag',
    agentKey: 'vibhaag',
    label: 'Classification',
    hi: 'वर्गीकरण',
    detail: 'categorising fields by DPDPA type',
  },
  {
    agent: 'Parikshan',
    agentKey: 'parikshan',
    label: 'Assessment',
    hi: 'मूल्यांकन',
    detail: 'scoring against the assigned control library',
  },
  {
    agent: 'Saakshi',
    agentKey: 'saakshi',
    label: 'Evidence',
    hi: 'साक्ष्य',
    detail: 'sealing supporting artifacts (WORM)',
  },
  {
    agent: 'Prativedan',
    agentKey: 'prativedan',
    label: 'Report',
    hi: 'रिपोर्ट',
    detail: 'generating findings + exposure',
  },
];

export function AssessmentClient({ snapshot }: AssessmentClientProps) {
  const router = useRouter();
  const controls = snapshot?.controls ?? [];
  const passCount = snapshot?.summary.pass ?? 0;
  const partialCount = snapshot?.summary.partial ?? 0;
  const failCount = snapshot?.summary.fail ?? 0;
  const unassessedCount = snapshot?.summary.unassessed ?? 0;
  const totalControlsCount = controls.length;
  const exposure =
    snapshot?.exposureInr == null
      ? 'Not assessed'
      : new Intl.NumberFormat('en-IN', {
          style: 'currency',
          currency: 'INR',
          maximumFractionDigits: 0,
        }).format(snapshot.exposureInr);
  const domains = [...new Set(controls.map((control) => control.domain))].map((domain) => {
    const rows = controls.filter((control) => control.domain === domain);
    return {
      name: domain,
      total: rows.length,
      pass: rows.filter((row) => row.status === 'pass').length,
      partial: rows.filter((row) => row.status === 'partial').length,
      fail: rows.filter((row) => row.status === 'fail').length,
      unassessed: rows.filter((row) => row.status === 'unassessed').length,
    };
  });
  const [assessRunning, setAssessRunning] = useState(false);
  const [hasCompleted, setHasCompleted] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [ledgerEntryId, setLedgerEntryId] = useState<string | null>(null);
  const inFlight = useRef(false);

  const runAssessment = async () => {
    if (inFlight.current || !snapshot?.engagement) return;
    inFlight.current = true;
    setAssessRunning(true);
    setHasCompleted(false);
    setRunError(null);
    setLedgerEntryId(null);
    try {
      const result = await invokeAgent('parikshan', {
        scope: 'assessment_pipeline',
        ...(snapshot?.engagement
          ? {
              engagement_id: snapshot.engagement.id,
              library_version: snapshot.engagement.libraryVersion,
            }
          : {}),
      });
      setLedgerEntryId(result.ledger_entry_ids.at(-1) ?? null);
      setHasCompleted(true);
      router.refresh();
    } catch (error) {
      setRunError(
        error instanceof AgentInvocationError
          ? error.message
          : 'Could not confirm the assessment outcome.',
      );
    } finally {
      inFlight.current = false;
      setAssessRunning(false);
    }
  };
  const pipelineMsg = assessRunning
    ? 'Parikshan invocation in progress'
    : 'Parikshan invocation completed. Saved results are refreshed separately.';

  return (
    <div className="mx-auto max-w-[1180px] animate-in fade-in-0 duration-200">
      <div
        data-testid="assessment-provenance"
        className="mb-4 rounded-lg border border-slate-200 bg-white p-4 text-sm text-slate-700"
      >
        {!snapshot ? (
          <p role="alert">
            Saved assessment results are unavailable for this selection. Check the assessment or try
            again.
          </p>
        ) : !snapshot.engagement ? (
          <p>
            No saved assessment exists for this tenant. Controls and exposure are not assessed.
            Create an assessment before running Parikshan.
          </p>
        ) : (
          <p>
            {snapshot.engagement.title} · Library {snapshot.engagement.libraryVersion} ·{' '}
            {snapshot.engagement.status}. Showing saved findings only; missing results are
            unassessed. Score bands retain the existing 80/40 presentation thresholds.
          </p>
        )}
      </div>
      {/* ============================================================ */}
      {/* 1. RUN PIPELINE HERO CARD (EXACT AXIOM PROOF APP DESIGN)     */}
      {/* ============================================================ */}
      <div className="mb-[18px] rounded-2xl bg-[#1E2A4A] p-5 text-white shadow-sm md:p-6">
        {/* Header: Title, Description & Action Button */}
        <div className="mb-4 flex flex-wrap items-center justify-between gap-4">
          <div className="flex-1 min-w-[240px]">
            <h1 className="font-heading text-[16px] font-semibold text-white leading-tight">
              Assessment pipeline
            </h1>
            <div className="mt-0.5 text-[11.5px] text-[#a9b3ce]">
              Runs Parikshan only for the displayed saved assessment. Discovery, evidence sealing
              and report generation run separately.
            </div>
          </div>

          <button
            type="button"
            onClick={runAssessment}
            disabled={assessRunning || !snapshot?.engagement}
            className={`rounded-[9px] px-[18px] py-[10px] text-[12.5px] font-bold text-white transition-all shadow-xs ${
              assessRunning || !snapshot?.engagement
                ? 'cursor-default bg-white/15 opacity-80'
                : 'cursor-pointer bg-[#0FB5A5] hover:bg-[#0a8d80]'
            }`}
          >
            {assessRunning ? 'Running Parikshan…' : 'Run Parikshan'}
          </button>
        </div>

        {/* 5-Stage Stepper Pipeline Row */}
        <div className="relative my-2 flex items-center gap-0">
          {PIPELINE_STAGES.map((p, i) => {
            const isCompleted = p.agentKey === 'parikshan' && hasCompleted;
            const isActive = p.agentKey === 'parikshan' && assessRunning;
            const dotBg = isCompleted || isActive ? '#0FB5A5' : 'rgba(255,255,255,.12)';
            const dotColor = isCompleted || isActive ? '#04322d' : '#ffffff';
            const mark = isCompleted ? '✓' : String(i + 1);

            return (
              <div
                key={p.agent}
                data-testid={`pipeline-${p.agentKey}`}
                data-state={isCompleted ? 'completed' : isActive ? 'running' : 'not-run'}
                className="group relative flex flex-1 flex-col items-center text-center"
              >
                {/* Horizontal connector line to next step */}
                {i < PIPELINE_STAGES.length - 1 && (
                  <div
                    className="absolute top-[17px] left-1/2 w-full h-[2px] z-0 transition-colors duration-500"
                    style={{
                      backgroundColor: 'rgba(255,255,255,.12)',
                    }}
                  />
                )}

                {/* Step Circle: 34px diameter, font-heading, 13px bold */}
                <div
                  className={`relative z-10 flex h-[34px] w-[34px] items-center justify-center rounded-full font-heading text-[13px] font-bold transition-all duration-300 select-none ${
                    isActive
                      ? 'animate-pulse ring-4 ring-[#0FB5A5]/40 shadow-lg shadow-[#0FB5A5]/20 scale-105'
                      : ''
                  }`}
                  style={{
                    backgroundColor: dotBg,
                    color: dotColor,
                  }}
                >
                  {mark}
                </div>

                {/* Agent Name with Mini Icon */}
                <div className="mt-2 flex items-center justify-center gap-1.5 text-white">
                  <AgentIcon
                    agent={p.agentKey}
                    size="xs"
                    state={isActive ? 'thinking' : isCompleted ? 'working' : 'idle'}
                    className="transition-transform group-hover:scale-110"
                  />
                  <span className="text-[12px] font-semibold">{p.agent}</span>
                </div>

                {/* Stage Label & Indic Subtitle */}
                <div className="mt-0.5 text-[10px] text-[#8a97b8]">
                  {p.label} · {p.hi}
                </div>
              </div>
            );
          })}
        </div>

        {runError && (
          <p
            data-testid="assessment-invocation-error"
            role="alert"
            className="mt-4 rounded-lg bg-white p-3 text-sm text-[#D9534F]"
          >
            {runError}
          </p>
        )}
        {/* Confirmed invocation state */}
        {(assessRunning || hasCompleted) && (
          <div className="mt-3.5 flex flex-wrap items-center justify-center gap-2 text-center text-[12px] text-[#0FB5A5] font-medium animate-in fade-in-0 duration-150">
            <span>● {pipelineMsg}</span>
            {ledgerEntryId && (
              <Link
                href={`/ledger?q=${ledgerEntryId}`}
                className="font-mono text-[11px] underline text-[#0FB5A5] hover:text-white"
              >
                (Ledger entry #{ledgerEntryId})
              </Link>
            )}
          </div>
        )}
      </div>

      {/* ============================================================ */}
      {/* 2. SUMMARY + EXPOSURE 3-CARD ROW                             */}
      {/* ============================================================ */}
      <div
        data-testid="assessment-summary"
        className="mb-[18px] grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_320px] gap-4"
      >
        {/* Posture Distribution Card */}
        <div className="rounded-2xl border border-[#e4e8ee] bg-white p-[18px_20px] shadow-2xs">
          <div className="mb-3 text-[11px] font-semibold uppercase tracking-[0.04em] text-[#8a909b]">
            {snapshot
              ? `Control posture (${passCount + partialCount + failCount} assessed of ${totalControlsCount})`
              : 'Control posture unavailable'}
          </div>
          <div className="mb-3 flex h-3 gap-1.5 overflow-hidden rounded-[20px]">
            <div style={{ flex: passCount }} className="bg-[#0FB5A5]" title={`${passCount} Pass`} />
            <div
              style={{ flex: partialCount }}
              className="bg-[#E0A82E]"
              title={`${partialCount} Partial`}
            />
            <div style={{ flex: failCount }} className="bg-[#D9534F]" title={`${failCount} Fail`} />
            <div
              style={{ flex: unassessedCount }}
              className="bg-slate-300"
              title={`${unassessedCount} Unassessed`}
            />
          </div>
          <div className="flex gap-[18px] text-[12px] text-[#2F3542]">
            <span>
              <b className="font-heading text-[16px] text-[#0a8d80] font-bold">
                {snapshot ? passCount : '—'}
              </b>{' '}
              pass
            </span>
            <span>
              <b className="font-heading text-[16px] text-[#8a6d10] font-bold">
                {snapshot ? partialCount : '—'}
              </b>{' '}
              partial
            </span>
            <span>
              <b className="font-heading text-[16px] text-[#D9534F] font-bold">
                {snapshot ? failCount : '—'}
              </b>{' '}
              fail
            </span>
            <span>{snapshot ? unassessedCount : '—'} unassessed</span>
          </div>
        </div>

        {/* SDF Self-Assessment Card */}
        <div className="rounded-2xl border border-[#e4e8ee] bg-white p-[18px_20px] shadow-2xs">
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.04em] text-[#8a909b]">
            Recorded SDF designation
          </div>
          <div className="font-heading text-[26px] font-bold text-[#1E2A4A] leading-tight">
            {!snapshot ? 'Unavailable' : snapshot.isSdf ? 'Designated' : 'Not recorded'}
          </div>
          <p className="mt-1 text-[11.5px] text-[#8a909b] leading-normal">
            Tenant profile value; this is not an automated statutory designation.
          </p>
        </div>

        {/* Penalty Exposure Estimate Card */}
        <div className="rounded-2xl border border-[#f0cbc9] bg-[#fbeceb] p-[18px_20px] shadow-2xs">
          <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.04em] text-[#D9534F]">
            Penalty exposure estimate
          </div>
          <div className="font-heading text-[30px] font-bold text-[#D9534F] leading-tight">
            {snapshot ? exposure : 'Unavailable'}
          </div>
          <p className="mt-1 text-[11px] text-[#a03734] leading-tight">
            Saved engagement estimate; no estimate is inferred from missing findings.
          </p>
        </div>
      </div>

      {/* ============================================================ */}
      {/* Saved domain coverage, derived only from the selected library. */}
      <section className="mb-4 rounded-2xl border border-slate-200 bg-white p-5">
        <h2 className="font-heading text-sm font-semibold">
          Saved control coverage ({domains.length} domains · {totalControlsCount} controls)
        </h2>
        <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-3">
          {domains.map((domain) => (
            <div key={domain.name} className="rounded-lg bg-slate-50 p-3 text-xs">
              <h3 className="font-semibold">{domain.name}</h3>
              <p>
                {domain.total} controls · {domain.pass} pass · {domain.partial} partial ·{' '}
                {domain.fail} fail · {domain.unassessed} unassessed
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* ============================================================ */}
      {/* 4. CONTROL TABLE (DYNAMIC CONTROLS & FINDINGS)               */}
      {/* ============================================================ */}
      <div className="overflow-hidden rounded-2xl border border-[#e4e8ee] bg-white shadow-2xs">
        {/* Table Header */}
        <div className="grid grid-cols-[90px_1fr_150px_110px_90px_70px] gap-2.5 border-b border-[#e4e8ee] bg-[#F4F6F8] px-[18px] py-[11px] text-[10px] font-semibold tracking-[0.04em] uppercase text-[#8a909b]">
          <span>Control</span>
          <span>Requirement</span>
          <span>Domain</span>
          <span>Citation</span>
          <span>Evidence</span>
          <span>Status</span>
        </div>

        {/* Table Rows */}
        <div className="divide-y divide-[#eef1f5]">
          {controls.length === 0 && (
            <p className="p-4 text-sm text-slate-500">
              {snapshot ? 'No saved control results.' : 'Control results unavailable.'}
            </p>
          )}
          {controls.map((c) => {
            const stColor =
              c.status === 'unassessed'
                ? '#64748b'
                : c.status === 'pass'
                  ? '#0a8d80'
                  : c.status === 'partial'
                    ? '#8a6d10'
                    : '#D9534F';
            const stBg =
              c.status === 'unassessed'
                ? '#f1f5f9'
                : c.status === 'pass'
                  ? '#e6f7f5'
                  : c.status === 'partial'
                    ? '#fbf3df'
                    : '#fbeceb';
            const stLabel =
              c.status === 'unassessed'
                ? 'UNASSESSED'
                : c.status === 'pass'
                  ? 'PASS'
                  : c.status === 'partial'
                    ? 'PARTIAL'
                    : 'FAIL';

            return (
              <div
                key={c.id}
                data-testid={`assessment-control-${c.id}`}
                className="grid grid-cols-[90px_1fr_150px_110px_90px_70px] items-center gap-2.5 px-[18px] py-3 hover:bg-[#F4F6F8]/60 transition-colors"
              >
                {/* Control ID with Link to Controls */}
                <Link
                  href={`/controls?q=${c.id}`}
                  className="font-mono text-[11px] font-medium text-[#1E2A4A] hover:underline"
                >
                  {c.id}
                </Link>

                {/* Requirement & Score Progress Bar */}
                <div>
                  <div className="text-[12.5px] font-medium text-[#2F3542] leading-snug">
                    {c.name}
                  </div>
                  <p className="text-xs text-slate-500">
                    {c.score === null ? 'No saved score' : `Saved score: ${c.score}`}
                  </p>
                  <div className="mt-1.5 h-[5px] max-w-[160px] overflow-hidden rounded-[20px] bg-[#F4F6F8]">
                    <div
                      style={{
                        width: `${c.score ?? 0}%`,
                        backgroundColor: stColor,
                      }}
                      className="h-full rounded-[20px] transition-all duration-700"
                    />
                  </div>
                </div>

                {/* Domain */}
                <span className="text-[11px] text-[#5b6270] truncate">{c.domain}</span>

                {/* Statutory Citation */}
                <span className="font-mono text-[10.5px] text-[#8a909b]">{c.cite || '—'}</span>

                {/* Evidence Artifact Link */}
                <div>
                  {c.evidenceIds.length > 0 ? (
                    <Link
                      href={`/evidence?q=${c.evidenceIds[0]}`}
                      className="inline-block rounded-[5px] bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] font-medium text-slate-700 hover:opacity-85"
                    >
                      {c.evidenceIds.length} cited
                    </Link>
                  ) : (
                    <span className="text-[10.5px] text-[#8a909b]">—</span>
                  )}
                </div>

                {/* Status Badge */}
                <div>
                  <span
                    style={{
                      color: stColor,
                      backgroundColor: stBg,
                    }}
                    className="inline-block rounded-[5px] px-[7px] py-[3px] text-[9px] font-bold uppercase"
                  >
                    {stLabel}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
