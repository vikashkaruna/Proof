'use client';

import React, { useState, useRef } from 'react';
import { invokeAgent, AgentInvocationError } from '@/lib/invoke-agent';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AgentIcon } from '@axiom/ui';
import type { AgentName } from '@axiom/types';

export interface ControlScore {
  id: string;
  name: string;
  domain: string;
  cite: string;
  ev: string;
  status: 'pass' | 'partial' | 'fail';
  score: number;
}

export interface TargetAreaScan {
  name: string;
  code: string;
  citation: string;
  controlsCount: number;
  passCount: number;
  partialCount: number;
  failCount: number;
  highlight: string;
}

export const TARGET_AREAS: TargetAreaScan[] = [
  {
    name: 'Notice & Consent Management',
    code: 'NOT',
    citation: 'DPDPA §5, §6 & Rule 3',
    controlsCount: 9,
    passCount: 7,
    partialCount: 1,
    failCount: 1,
    highlight: 'Multilingual notices (22 languages), purpose specifications & withdrawal workflows',
  },
  {
    name: 'Principal Rights & DSAR Automation',
    code: 'RTS',
    citation: 'DPDPA §11–§14 & Rule 16',
    controlsCount: 7,
    passCount: 5,
    partialCount: 2,
    failCount: 0,
    highlight: 'Access, correction, erasure, grievance redressal & nominee registration',
  },
  {
    name: 'Retention & Purpose Limitation',
    code: 'RET',
    citation: 'DPDPA §8(7) & Rule 8',
    controlsCount: 5,
    passCount: 4,
    partialCount: 1,
    failCount: 0,
    highlight: 'Automated data minimization, TTL retention policies & purpose cessation purging',
  },
  {
    name: 'Purpose Limitation & Legitimate Uses',
    code: 'PUR',
    citation: 'DPDPA §6 & §7',
    controlsCount: 4,
    passCount: 4,
    partialCount: 0,
    failCount: 0,
    highlight: 'Strict use bounding, secondary processing prevention & employment data checks',
  },
  {
    name: 'Security Safeguards & Access Controls',
    code: 'SEC',
    citation: 'DPDPA §8(4), §8(5)',
    controlsCount: 11,
    passCount: 9,
    partialCount: 2,
    failCount: 0,
    highlight: 'Encryption in transit & rest, RBAC isolation, credential rotation & WORM logs',
  },
  {
    name: 'Cross-Border Transfers & Residency',
    code: 'XBR',
    citation: 'DPDPA §16 (ap-south-1)',
    controlsCount: 3,
    passCount: 3,
    partialCount: 0,
    failCount: 0,
    highlight:
      'Strict sovereign domestic residency in Mumbai (ap-south-1), zero unnotified foreign egress',
  },
  {
    name: 'Breach Readiness & 72-Hour Reporting',
    code: 'BRC',
    citation: 'DPDPA Rule 7 & CERT-In',
    controlsCount: 4,
    passCount: 3,
    partialCount: 1,
    failCount: 0,
    highlight:
      'Automated 72-hour board clock, principal notification templates & incident runbooks',
  },
  {
    name: 'Significant Data Fiduciary (SDF)',
    code: 'SDF',
    citation: 'DPDPA §10',
    controlsCount: 4,
    passCount: 3,
    partialCount: 1,
    failCount: 0,
    highlight: 'Resident DPO mandate, periodic statutory compliance audit & DPIA execution',
  },
  {
    name: "Children's & Sensitive Data Protection",
    code: 'CHD',
    citation: 'DPDPA §9',
    controlsCount: 3,
    passCount: 2,
    partialCount: 1,
    failCount: 0,
    highlight: 'Verifiable parental consent, age verification gating & behavioral profiling ban',
  },
];

export interface AssessmentClientProps {
  initialControls: ControlScore[];
  initialPassCount: number;
  initialPartialCount: number;
  initialFailCount: number;
  isSdf: boolean;
  exposureText: string;
  totalControlsCount: number;
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
    detail: 'scoring against control library v25.11.2',
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

export function AssessmentClient({
  initialControls,
  initialPassCount,
  initialPartialCount,
  initialFailCount,
  isSdf,
  exposureText,
  totalControlsCount,
}: AssessmentClientProps) {
  const router = useRouter();
  // Saved results come from server props. A local animation cannot change them.
  const controls = initialControls;
  const passCount = initialPassCount;
  const partialCount = initialPartialCount;
  const failCount = initialFailCount;
  const exposure = exposureText;
  const [assessRunning, setAssessRunning] = useState(false);
  const [hasCompleted, setHasCompleted] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [ledgerEntryId, setLedgerEntryId] = useState<string | null>(null);
  const inFlight = useRef(false);

  const runAssessment = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setAssessRunning(true);
    setHasCompleted(false);
    setRunError(null);
    setLedgerEntryId(null);
    try {
      const result = await invokeAgent('parikshan', { scope: 'assessment_pipeline' });
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
    : 'Parikshan invocation completed. Displaying saved results.';

  return (
    <div className="mx-auto max-w-[1180px] animate-in fade-in-0 duration-200">
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
              Runs Parikshan only. Discovery, evidence sealing and report generation run separately.
            </div>
          </div>

          <button
            type="button"
            onClick={runAssessment}
            disabled={assessRunning}
            className={`rounded-[9px] px-[18px] py-[10px] text-[12.5px] font-bold text-white transition-all shadow-xs ${
              assessRunning
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
          <p role="alert" className="mt-4 rounded-lg bg-white p-3 text-sm text-[#D9534F]">
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
            Control posture (showing {passCount + partialCount + failCount} of {totalControlsCount})
          </div>
          <div className="mb-3 flex h-3 gap-1.5 overflow-hidden rounded-[20px]">
            <div
              style={{ flex: Math.max(passCount, 1) }}
              className="bg-[#0FB5A5]"
              title={`${passCount} Pass`}
            />
            <div
              style={{ flex: Math.max(partialCount, 1) }}
              className="bg-[#E0A82E]"
              title={`${partialCount} Partial`}
            />
            <div
              style={{ flex: Math.max(failCount, 1) }}
              className="bg-[#D9534F]"
              title={`${failCount} Fail`}
            />
          </div>
          <div className="flex gap-[18px] text-[12px] text-[#2F3542]">
            <span>
              <b className="font-heading text-[16px] text-[#0a8d80] font-bold">{passCount}</b> pass
            </span>
            <span>
              <b className="font-heading text-[16px] text-[#8a6d10] font-bold">{partialCount}</b>{' '}
              partial
            </span>
            <span>
              <b className="font-heading text-[16px] text-[#D9534F] font-bold">{failCount}</b> fail
            </span>
          </div>
        </div>

        {/* SDF Self-Assessment Card */}
        <div className="rounded-2xl border border-[#e4e8ee] bg-white p-[18px_20px] shadow-2xs">
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.04em] text-[#8a909b]">
            SDF self-assessment
          </div>
          <div className="font-heading text-[26px] font-bold text-[#1E2A4A] leading-tight">
            {isSdf ? 'Significant Data Fiduciary' : 'Not designated'}
          </div>
          <p className="mt-1 text-[11.5px] text-[#8a909b] leading-normal">
            {isSdf
              ? 'Meets Section 10 thresholds. Resident DPO & Data Protection Impact Assessments mandatory.'
              : 'Below SDF thresholds on volume + sensitivity. Re-evaluated each scan.'}
          </p>
        </div>

        {/* Penalty Exposure Estimate Card */}
        <div className="rounded-2xl border border-[#f0cbc9] bg-[#fbeceb] p-[18px_20px] shadow-2xs">
          <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.04em] text-[#D9534F]">
            Penalty exposure estimate
          </div>
          <div className="font-heading text-[30px] font-bold text-[#D9534F] leading-tight">
            {exposure}
          </div>
          <p className="mt-1 text-[11px] text-[#a03734] leading-tight">
            weighted across open gaps · max ₹250 cr / contravention · illustrative, not legal advice
          </p>
        </div>
      </div>

      {/* ============================================================ */}
      {/* 3. TARGET STATUTORY AUDIT AREAS SCANNED (9 DOMAINS · 46 CONTROLS) */}
      {/* ============================================================ */}
      <div className="mb-[18px] rounded-2xl border border-[#e4e8ee] bg-white p-5 shadow-2xs">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-3 mb-3">
          <div className="flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-[#0FB5A5] animate-pulse" />
            <h2 className="font-heading text-sm font-semibold text-[#1E2A4A] uppercase tracking-wider">
              Target Statutory Audit Areas Scanned (9 Domains · 46 Controls)
            </h2>
          </div>
          <span className="font-mono text-xs text-slate-500">
            DPDPA 2023 Statutory Suite · ap-south-1
          </span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {TARGET_AREAS.map((area) => (
            <div
              key={area.code}
              className="rounded-xl border border-slate-100 bg-[#F8FAFC] p-3.5 hover:border-slate-300 transition-colors"
            >
              <div className="flex items-start justify-between gap-2">
                <div>
                  <span className="font-mono text-[10px] font-bold text-indigo-700 bg-indigo-50 px-1.5 py-0.5 rounded">
                    {area.code}
                  </span>
                  <h3 className="text-xs font-bold text-[#1E2A4A] mt-1 line-clamp-1">
                    {area.name}
                  </h3>
                </div>
                <span className="font-mono text-[10px] text-slate-400 shrink-0">
                  {area.citation}
                </span>
              </div>
              <p className="mt-1.5 text-[11px] text-slate-600 leading-snug line-clamp-2">
                {area.highlight}
              </p>
              <div className="mt-2.5 flex items-center justify-between pt-2 border-t border-slate-200/60 text-[10.5px]">
                <span className="text-slate-500 font-mono">{area.controlsCount} controls</span>
                <div className="flex items-center gap-1.5 font-semibold">
                  <span className="text-teal-700">{area.passCount} pass</span>
                  {area.partialCount > 0 && (
                    <span className="text-amber-700">· {area.partialCount} part</span>
                  )}
                  {area.failCount > 0 && (
                    <span className="text-red-600">· {area.failCount} fail</span>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

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
          {controls.map((c) => {
            const stColor =
              c.status === 'pass' ? '#0a8d80' : c.status === 'partial' ? '#8a6d10' : '#D9534F';
            const stBg =
              c.status === 'pass' ? '#e6f7f5' : c.status === 'partial' ? '#fbf3df' : '#fbeceb';
            const stLabel =
              c.status === 'pass' ? 'PASS' : c.status === 'partial' ? 'PARTIAL' : 'FAIL';

            return (
              <div
                key={c.id}
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
                  <div className="mt-1.5 h-[5px] max-w-[160px] overflow-hidden rounded-[20px] bg-[#F4F6F8]">
                    <div
                      style={{
                        width: `${c.score}%`,
                        backgroundColor: stColor,
                      }}
                      className="h-full rounded-[20px] transition-all duration-700"
                    />
                  </div>
                </div>

                {/* Domain */}
                <span className="text-[11px] text-[#5b6270] truncate">{c.domain}</span>

                {/* Statutory Citation */}
                <span className="font-mono text-[10.5px] text-[#8a909b]">{c.cite}</span>

                {/* Evidence Artifact Link */}
                <div>
                  {c.ev !== '—' ? (
                    <Link
                      href={`/evidence?q=${c.ev}`}
                      className="inline-block rounded-[5px] bg-[#f7f0d8] px-1.5 py-0.5 font-mono text-[10px] font-medium text-[#8a6d10] hover:opacity-85"
                    >
                      ✦ {c.ev}
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
