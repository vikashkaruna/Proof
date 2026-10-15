'use client';

import React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AgentLabel, formatINRCrore, PageHeader } from '@axiom/ui';
import { moduleBarProps } from '@/lib/module-bar';
import type { AgentName, AssessmentSnapshot } from '@axiom/types';
import { AssessmentRequestPanel } from './request-panel';

export interface AssessmentClientProps {
  snapshot: AssessmentSnapshot | null;
  canCreate?: boolean;
  canInvokeAgent?: boolean;
  actorId?: string;
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

export function AssessmentClient({
  snapshot,
  canCreate = false,
  canInvokeAgent = false,
  actorId,
}: AssessmentClientProps) {
  const router = useRouter();
  const controls = snapshot?.controls ?? [];
  const passCount = snapshot?.summary.pass ?? 0;
  const partialCount = snapshot?.summary.partial ?? 0;
  const failCount = snapshot?.summary.fail ?? 0;
  const unassessedCount = snapshot?.summary.unassessed ?? 0;
  const unknownCount = snapshot?.summary.unknown ?? 0;
  const notApplicableCount = snapshot?.summary.not_applicable ?? 0;
  const provenance = snapshot?.provenance;
  const hasDeclarations = provenance?.status === 'caller_declared_unverified';
  const totalControlsCount = controls.length;
  const exposure =
    snapshot?.exposureInr == null ? 'Not assessed' : formatINRCrore(snapshot.exposureInr);
  const domains = [...new Set(controls.map((control) => control.domain))].map((domain) => {
    const rows = controls.filter((control) => control.domain === domain);
    return {
      name: domain,
      total: rows.length,
      pass: rows.filter((row) => row.status === 'pass').length,
      partial: rows.filter((row) => row.status === 'partial').length,
      fail: rows.filter((row) => row.status === 'fail').length,
      unassessed: rows.filter((row) => row.status === 'unassessed').length,
      unknown: rows.filter((row) => row.status === 'unknown').length,
      notApplicable: rows.filter((row) => row.status === 'not_applicable').length,
    };
  });

  return (
    <div className="min-w-0 w-full animate-in fade-in-0 duration-200">
      <PageHeader
        className="mb-4"
        title="Assessment"
        module={moduleBarProps('assessment')}
        description="Request Parikshan for the displayed saved assessment below. Discovery, evidence sealing and report generation run separately."
      >
        {/* 5-Stage Stepper Pipeline Row */}
        <div
          className="relative my-2 flex w-full min-w-0 items-center gap-0 overflow-x-auto pb-2"
          role="region"
          aria-label="Assessment pipeline stages"
          tabIndex={0}
        >
          {PIPELINE_STAGES.map((p, i) => {
            const isCompleted = p.agentKey === 'parikshan' && hasDeclarations;
            const dotBg = isCompleted ? '#0FB5A5' : 'rgba(255,255,255,.12)';
            const dotColor = isCompleted ? '#04322d' : '#ffffff';
            const mark = isCompleted ? '✓' : String(i + 1);

            return (
              <div
                key={p.agent}
                data-testid={`pipeline-${p.agentKey}`}
                data-state={isCompleted ? 'completed' : 'not-run'}
                className="group relative flex min-w-[110px] flex-1 flex-col items-center text-center"
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
                  className="relative z-10 flex h-[34px] w-[34px] items-center justify-center rounded-full font-heading text-[13px] font-bold select-none"
                  style={{
                    backgroundColor: dotBg,
                    color: dotColor,
                  }}
                >
                  {mark}
                </div>

                {/* Agent Name with Mini Icon */}
                <div className="mt-2 flex items-center justify-center text-white">
                  <AgentLabel agent={p.agentKey} size="xs" tone="dark" state="idle" />
                </div>

                {/* Stage Label & Indic Subtitle */}
                <div className="mt-0.5 text-[10px] text-[#8a97b8]">
                  {p.label} · {p.hi}
                </div>
              </div>
            );
          })}
        </div>
      </PageHeader>

      {snapshot?.engagement && actorId && (
        <AssessmentRequestPanel
          tenantId={snapshot.tenantId}
          actorId={actorId}
          engagementId={snapshot.engagement.id}
          libraryVersion={snapshot.engagement.libraryVersion}
          canRequest={canInvokeAgent}
          hasSavedResults={controls.some((control) => control.score !== null)}
          onFinalized={() => router.refresh()}
        />
      )}

      <div
        data-testid="assessment-provenance"
        className="mb-4 rounded-lg border border-slate-200 bg-white p-4 text-sm text-slate-700"
      >
        {!snapshot ? (
          <p role="alert">
            Saved assessment results are unavailable for this selection. Refresh to try again, or{' '}
            <Link href="/engagements" className="font-semibold text-teal-700 underline">
              {canCreate ? 'Choose or create an assessment' : 'Choose an assessment'}
            </Link>
            . Existing assessment history is preserved.
          </p>
        ) : !snapshot.engagement ? (
          <p>
            No saved assessment exists for this tenant. Controls and exposure are not assessed.{' '}
            {canCreate ? (
              <Link href="/engagements" className="font-semibold text-teal-700 underline">
                Create an assessment
              </Link>
            ) : (
              'Ask an assessment owner to create one'
            )}{' '}
            before running Parikshan.
          </p>
        ) : (
          <div>
            <p>
              {snapshot.engagement.title} · Library {snapshot.engagement.libraryVersion} ·{' '}
              {snapshot.engagement.status}. Showing saved findings only; missing results are
              unassessed. Score bands use the 80/40 presentation thresholds, not a compliance
              determination.
            </p>
            <p className="mt-2" data-testid="assessment-questionnaire-provenance">
              {hasDeclarations
                ? 'Questionnaire declarations are unverified. Scores and exposure are provisional estimates requiring review. Unknown answers or applicability are not a failed control.'
                : 'Questionnaire provenance is unavailable for these saved results. Score bands do not establish verified answers or compliance.'}
            </p>
            {hasDeclarations && provenance.applicability && (
              <dl
                className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-xs"
                aria-label="Questionnaire applicability declarations"
              >
                {(
                  [
                    ['SDF self-attestation', provenance.applicability.sdfSelfAttested],
                    ['Processes children’s data', provenance.applicability.processesChildren],
                    ['Processes health data', provenance.applicability.processesHealth],
                  ] as const
                ).map(([label, declaration]) => (
                  <div key={label}>
                    <dt className="font-semibold">{label}</dt>
                    <dd>
                      {declaration.value === null
                        ? 'Unknown'
                        : declaration.value
                          ? 'Declared yes · unverified'
                          : 'Declared no · unverified'}
                    </dd>
                  </div>
                ))}
              </dl>
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
            <div
              style={{ flex: unknownCount }}
              className="bg-slate-400"
              title={`${unknownCount} Unknown`}
            />
            <div
              style={{ flex: notApplicableCount }}
              className="bg-slate-200"
              title={`${notApplicableCount} Not applicable · declaration unverified`}
            />
          </div>
          <div className="flex flex-wrap gap-x-[18px] gap-y-2 text-[12px] text-[#2F3542]">
            <span>
              <b className="font-heading text-[16px] text-[#0a8d80] font-bold">
                {snapshot ? passCount : '—'}
              </b>{' '}
              pass
            </span>
            <span>
              <b className="font-heading text-[16px] text-[#B45309] font-bold">
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
            {unknownCount > 0 && <span>{unknownCount} unknown</span>}
            {notApplicableCount > 0 && (
              <span>{notApplicableCount} not applicable · unverified</span>
            )}
          </div>
          {hasDeclarations && (
            <p className="mt-2 text-xs text-slate-600">
              Pass, partial and fail are provisional score bands.
            </p>
          )}
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
            {hasDeclarations
              ? 'Provisional estimate from unverified declarations; review applicability and supporting evidence.'
              : 'Saved engagement estimate; questionnaire provenance is unavailable. No estimate is inferred from missing findings.'}
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
                {domain.unknown > 0 && ` · ${domain.unknown} unknown`}
                {domain.notApplicable > 0 &&
                  ` · ${domain.notApplicable} not applicable (unverified)`}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* ============================================================ */}
      {/* 4. CONTROL TABLE (DYNAMIC CONTROLS & FINDINGS)               */}
      {/* ============================================================ */}
      <div
        className="w-full overflow-x-auto rounded-2xl border border-[#e4e8ee] bg-white shadow-2xs"
        role="region"
        aria-label="Saved control results"
        tabIndex={0}
      >
        {/* Table Header */}
        <div className="grid min-w-[700px] grid-cols-[90px_1fr_150px_110px_90px_70px] gap-2.5 border-b border-[#e4e8ee] bg-[#F4F6F8] px-[18px] py-[11px] text-[10px] font-semibold tracking-[0.04em] uppercase text-[#8a909b]">
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
            const stColor = ['unassessed', 'unknown', 'not_applicable'].includes(c.status)
              ? '#64748b'
              : c.status === 'pass'
                ? '#0a8d80'
                : c.status === 'partial'
                  ? '#B45309'
                  : '#D9534F';
            const stBg = ['unassessed', 'unknown', 'not_applicable'].includes(c.status)
              ? '#f1f5f9'
              : c.status === 'pass'
                ? '#e6f7f5'
                : c.status === 'partial'
                  ? '#fbf3df'
                  : '#fbeceb';
            const stLabel = c.status.replaceAll('_', ' ').toUpperCase();

            return (
              <div
                key={c.id}
                data-testid={`assessment-control-${c.id}`}
                className="grid min-w-[700px] grid-cols-[90px_1fr_150px_110px_90px_70px] items-center gap-2.5 px-[18px] py-3 hover:bg-[#F4F6F8]/60 transition-colors"
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
                    {c.score === null
                      ? 'No saved score'
                      : `${hasDeclarations ? 'Provisional score' : 'Saved score'}: ${c.score}`}
                  </p>
                  {c.answerCounts && (
                    <p className="mt-1 text-xs text-slate-600">
                      {c.answerCounts.unknown} of {c.answerCounts.knownBooleanQuestions} boolean
                      answers unknown ·{' '}
                      {c.answerCounts.callerAffirmed + c.answerCounts.callerDenied} declared,
                      unverified
                    </p>
                  )}
                  {c.applicabilityState === 'unknown' && (
                    <p className="text-xs text-slate-600">Applicability unknown</p>
                  )}
                  {c.applicabilityState === 'caller_declared_not_applicable_unverified' && (
                    <p className="text-xs text-slate-600">
                      Not applicable by caller declaration · requires review
                    </p>
                  )}
                  {c.answerState === 'not_boolean_assessable' && (
                    <p className="text-xs text-slate-600">
                      No boolean questionnaire basis for this score
                    </p>
                  )}
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
