/**
 * Board Report contracts, schema validation, and deterministic HTML rendering.
 * Strictly adheres to Axiom Proof design tokens and regulatory DPDPA standards.
 */
import { z } from 'zod';
import {
  PublicControlReportAppendixSchema,
  PublicWebsiteAssetScopeSchema,
  renderPublicControlReportAppendix,
} from './public-control-provenance';
import { BRANDING } from './schema';
import {
  AssessmentReportInterpretationSchema,
  AssessmentReportSummarySchema,
  AssessmentReportFindingInterpretationSchema,
} from './assessment-interpretation';

const uuid = z.string().regex(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const timestamp = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/)
  .refine((v) => Number.isFinite(Date.parse(v)));

export const BoardReportFindingSchema = z.object({
  control_id: z.string().min(1).max(100),
  domain: z.string().min(1).max(50),
  severity: z.enum(['critical', 'high', 'medium', 'low', 'info']),
  title: z.string().min(1).max(300),
  score: z.number().min(0).max(100),
  gap_summary: z.string().min(1).max(2000),
  remediation_recommendation: z.string().min(1).max(2000),
});
export type BoardReportFinding = z.infer<typeof BoardReportFindingSchema>;

export const BoardReportActionItemSchema = z.object({
  step: z.number().int().min(1),
  title: z.string().min(1).max(200),
  owner: z.string().min(1).max(100),
  timeline_days: z.number().int().min(1).max(365),
  priority: z.enum(['p0', 'p1', 'p2', 'p3']),
});
export type BoardReportActionItem = z.infer<typeof BoardReportActionItemSchema>;

export const BoardReportContentV1Schema = z.object({
  schema_version: z.literal(1),
  kind: z.literal('board_report'),
  report_id: uuid.optional(),
  title: z.string().min(1).max(300),
  tenant_id: uuid,
  engagement_id: uuid,
  assessment_run_id: uuid,
  /** Exact database-frozen source snapshot used for this generated draft. */
  source_sha256: hash.optional(),
  assessment_result_digest: hash,
  library_version: z.string().min(1).max(100),
  library_digest: hash,
  generated_at: timestamp,
  branding: z
    .object({
      product: z.literal(BRANDING.product),
      company: z.literal(BRANDING.company),
      company_url: z.literal(BRANDING.company_url),
    })
    .default({
      product: BRANDING.product,
      company: BRANDING.company,
      company_url: BRANDING.company_url,
    }),
  executive_summary: z.object({
    posture_score: z.number().min(0).max(100),
    total_controls: z.number().int().min(0),
    passed_controls: z.number().int().min(0),
    failed_controls: z.number().int().min(0),
    critical_gaps: z.number().int().min(0),
    high_gaps: z.number().int().min(0),
    medium_gaps: z.number().int().min(0),
    low_gaps: z.number().int().min(0),
    estimated_exposure_inr: z.number().min(0),
    narrative: z.string().min(10).max(10000),
  }),
  key_findings: z.array(BoardReportFindingSchema).max(500),
  action_plan: z.array(BoardReportActionItemSchema).max(50),
  signatures: z.object({
    prepared_by: z.object({
      name: z.string().min(1).max(100),
      role: z.string().min(1).max(100),
      agent: z.enum(['prativedan', 'board-report-builder']),
    }),
    approved_by: z
      .object({
        user_id: uuid,
        name: z.string().min(1).max(200),
        role: z.string().min(1).max(100),
        timestamp: timestamp,
        review_sha256: hash.optional(),
      })
      .nullable()
      .default(null),
  }),
});
export type BoardReportContentV1 = z.infer<typeof BoardReportContentV1Schema>;

export const BoardReportFindingV2Schema = BoardReportFindingSchema.extend({
  ...AssessmentReportFindingInterpretationSchema.shape,
  gap_summary: z.string().min(1).max(4000),
  remediation_recommendation: z.string().min(1).max(4000),
})
  .strict()
  .superRefine((finding, ctx) => {
    const interpretation = AssessmentReportFindingInterpretationSchema.safeParse({
      display_state: finding.display_state,
      answer_state: finding.answer_state,
      applicability_state: finding.applicability_state,
      answer_counts: finding.answer_counts,
      score_band: finding.score_band,
    });
    if (
      !interpretation.success ||
      (finding.score_band !== null &&
        finding.score_band !==
          (finding.score >= 80
            ? 'at_least_80'
            : finding.score >= 40
              ? 'from_40_to_under_80'
              : 'under_40'))
    )
      ctx.addIssue({ code: 'custom', message: 'Finding interpretation is inconsistent' });
  });
export const BoardReportContentV2Schema = BoardReportContentV1Schema.omit({
  schema_version: true,
  executive_summary: true,
  key_findings: true,
})
  .extend({
    schema_version: z.literal(2),
    questionnaire_interpretation: AssessmentReportInterpretationSchema,
    executive_summary: AssessmentReportSummarySchema,
    key_findings: z.array(BoardReportFindingV2Schema).max(500),
  })
  .strict()
  .superRefine((content, ctx) => {
    const findings = content.key_findings,
      summary = content.executive_summary;
    if (
      new Set(findings.map((f) => f.control_id)).size !== findings.length ||
      findings.length !== summary.total_controls ||
      summary.unknown_controls !== findings.filter((f) => f.display_state === 'unknown').length ||
      summary.not_applicable_controls !==
        findings.filter((f) => f.display_state === 'declared_not_applicable_unverified').length ||
      summary.not_boolean_assessable_controls !==
        findings.filter((f) => f.display_state === 'not_boolean_assessable').length ||
      summary.provenance_unavailable_controls !==
        findings.filter((f) => f.display_state === 'provenance_unavailable').length ||
      Object.entries(summary.provisional_score_bands).some(
        ([band, count]) => count !== findings.filter((f) => f.score_band === band).length,
      ) ||
      (content.questionnaire_interpretation.provenance === 'unavailable'
        ? summary.provenance_unavailable_controls !== summary.total_controls
        : summary.provenance_unavailable_controls !== 0)
    )
      ctx.addIssue({ code: 'custom', message: 'Board interpretation register is incomplete' });
  });
export const BoardReportContentV3Schema = z
  .object({
    ...BoardReportContentV2Schema.shape,
    schema_version: z.literal(3),
    public_review_appendix: PublicControlReportAppendixSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    const { public_review_appendix: appendix, ...base } = value;
    void appendix;
    const legacy = BoardReportContentV2Schema.safeParse({ ...base, schema_version: 2 });
    if (!legacy.success)
      ctx.addIssue({ code: 'custom', message: 'Board interpretation register is incomplete' });
  });
export const BoardReportContentV4Schema = z
  .object({
    ...BoardReportContentV3Schema.shape,
    schema_version: z.literal(4),
    asset_scope: PublicWebsiteAssetScopeSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    const { asset_scope, ...base } = value;
    if (
      !BoardReportContentV3Schema.safeParse({ ...base, schema_version: 3 }).success ||
      asset_scope.estate.id !== value.public_review_appendix.estateId ||
      asset_scope.association.payload_sha256 !==
        value.public_review_appendix.capturePayloadSha256 ||
      asset_scope.association.capture_receipt.id !==
        value.public_review_appendix.captureReceipt.id ||
      asset_scope.association.capture_receipt.entryHash !==
        value.public_review_appendix.captureReceipt.entry_hash
    )
      ctx.addIssue({ code: 'custom', message: 'Board asset scope differs from retained review' });
  });
export const BoardReportContentSchema = z.discriminatedUnion('schema_version', [
  BoardReportContentV1Schema,
  BoardReportContentV2Schema,
  BoardReportContentV3Schema,
  BoardReportContentV4Schema,
]);
export type BoardReportContentV4 = z.infer<typeof BoardReportContentV4Schema>;
export type BoardReportContentV3 = z.infer<typeof BoardReportContentV3Schema>;
export type BoardReportContentV2 = z.infer<typeof BoardReportContentV2Schema>;
export type BoardReportContent = z.infer<typeof BoardReportContentSchema>;

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatInr(amount: number): string {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 0,
  }).format(amount);
}

/**
 * Deterministically renders a valid, self-contained HTML document for a Board Report.
 * Uses strict inline CSS styles with Axiom design tokens suitable for headless Chromium PDF printing.
 */
export function renderBoardReportHtml(content: BoardReportContent): string {
  const validated = BoardReportContentSchema.parse(content);
  const preparedByRenderer = validated.signatures.prepared_by.agent === 'board-report-builder';
  const es = validated.executive_summary;
  const v2 = validated.schema_version !== 1 ? validated : null;
  const legacy = validated.schema_version === 1 ? validated : null;
  const scoreColor = '#64748B';
  const scoreTitle = v2 ? 'Provisional Posture Score' : 'Recorded Posture Score';
  const scoreDetail = v2
    ? `${Object.values(v2.executive_summary.provisional_score_bands).reduce((sum, n) => sum + n, 0)} / ${es.total_controls} controls with complete unverified declarations`
    : `${legacy!.executive_summary.passed_controls} / ${es.total_controls} saved scores at least 80; provenance unavailable`;
  const reviewTitle = v2 ? 'Assessment Review Required' : 'Recorded Below-80 Priority Bands';
  const reviewValue = v2
    ? es.total_controls
    : legacy!.executive_summary.critical_gaps + legacy!.executive_summary.high_gaps;
  const reviewDetail = v2
    ? `${v2.executive_summary.unknown_controls} unknown · ${v2.executive_summary.not_boolean_assessable_controls} without Boolean questions · ${v2.executive_summary.provenance_unavailable_controls} provenance unavailable · ${v2.executive_summary.not_applicable_controls} declared exclusions (unverified)`
    : 'Historical numerical bands; questionnaire provenance unavailable';
  const provenanceNotice = v2
    ? `Questionnaire ${v2.questionnaire_interpretation.provenance === 'unavailable' ? 'provenance is unavailable' : 'declarations and applicability remain unverified'}. Scores and exposure are provisional estimates. Supporting evidence and human/legal review are required.`
    : 'Historical report: questionnaire provenance is unavailable. Saved score bands and exposure require supporting evidence and human/legal review.';
  const findingStates = new Map(v2?.key_findings.map((f) => [f.control_id, f]));
  const findingsHtml = validated.key_findings
    .map((f) => {
      const interpretation = findingStates.get(f.control_id);
      const statusLabel = interpretation
        ? {
            unknown: 'Unknown answers or applicability',
            declared_not_applicable_unverified: 'Caller-declared exclusion (unverified)',
            not_boolean_assessable: 'No Boolean assessment questions',
            provisional_score_band: 'Provisional numerical score band',
            provenance_unavailable: 'Questionnaire provenance unavailable',
          }[interpretation.display_state]
        : 'Questionnaire provenance unavailable';
      const sevColor =
        interpretation?.display_state !== 'provisional_score_band'
          ? '#64748B'
          : f.severity === 'critical'
            ? '#D9534F'
            : f.severity === 'high'
              ? '#E67E22'
              : f.severity === 'medium'
                ? '#F1C40F'
                : '#3498DB';
      return `
      <tr class="finding-row">
        <td class="code-col"><strong>${escapeHtml(f.control_id)}</strong></td>
        <td><span class="badge" style="background-color: ${sevColor}; color: #fff;">${escapeHtml(f.severity.toUpperCase())}</span></td>
        <td><strong>${escapeHtml(f.title)}</strong><br/><span class="text-muted">${escapeHtml(f.domain)}</span></td>
        <td class="score-cell">${f.score}%<br/><span class="text-muted">${escapeHtml(statusLabel)}</span></td>
        <td>${escapeHtml(f.gap_summary)}</td>
        <td>${escapeHtml(f.remediation_recommendation)}</td>
      </tr>`;
    })
    .join('\n');

  const actionPlanHtml = validated.action_plan
    .map(
      (a) => `
      <tr>
        <td class="text-center"><strong>${a.step}</strong></td>
        <td><strong>${escapeHtml(a.title)}</strong></td>
        <td>${escapeHtml(a.owner)}</td>
        <td class="text-center">${a.timeline_days} days</td>
        <td class="text-center"><span class="badge badge-priority">${escapeHtml(a.priority.toUpperCase())}</span></td>
      </tr>`,
    )
    .join('\n');

  const approvalBlockHtml = validated.signatures.approved_by
    ? `
      <div class="signature-box approved">
        <div class="sig-header" style="color: #0FB5A5;">✓ REVIEWER APPROVAL RECORDED</div>
        <div class="sig-name"><strong>${escapeHtml(validated.signatures.approved_by.name)}</strong></div>
        <div class="sig-role">${escapeHtml(validated.signatures.approved_by.role)}</div>
        <div class="sig-meta">User ID: ${escapeHtml(validated.signatures.approved_by.user_id)}</div>
        <div class="sig-meta">Timestamp: ${escapeHtml(validated.signatures.approved_by.timestamp)}</div>
        ${validated.signatures.approved_by.review_sha256 ? `<div class="sig-meta">Recorded review SHA-256: ${escapeHtml(validated.signatures.approved_by.review_sha256)}</div>` : ''}
        <div class="review-badge">REVIEWED</div>
      </div>`
    : `
      <div class="signature-box pending">
        <div class="sig-header" style="color: #64748B;">⚠ DRAFT · PENDING FOUNDER APPROVAL</div>
        <div class="sig-role">Requires review and sign-off by an Axiom-internal Founder before formal release.</div>
        <div class="sig-meta">Status: Unreleased Draft</div>
      </div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(validated.title)} — ${escapeHtml(validated.branding.product)}</title>
  <style>
    @page {
      size: A4 portrait;
      margin: 15mm;
    }
    *, *::before, *::after {
      box-sizing: border-box;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      color: #1E293B;
      background: #FFFFFF;
      margin: 0;
      padding: 0;
      font-size: 13px;
      line-height: 1.5;
    }
    .header-banner {
      background: #1E2A4A;
      color: #FFFFFF;
      padding: 24px 30px;
      border-radius: 8px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 24px;
    }
    .brand-title {
      font-size: 24px;
      font-weight: 700;
      letter-spacing: -0.5px;
      margin: 0 0 6px 0;
    }
    .brand-subtitle {
      font-size: 12px;
      color: #94A3B8;
      margin: 0;
    }
    .report-badge {
      background: #0FB5A5;
      color: #1E2A4A;
      font-size: 11px;
      font-weight: 700;
      padding: 6px 14px;
      border-radius: 4px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .summary-grid {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 16px;
      margin-bottom: 24px;
    }
    .metric-card {
      border: 1px solid #E2E8F0;
      border-radius: 8px;
      padding: 16px;
      background: #F8FAFC;
    }
    .metric-title {
      font-size: 11px;
      font-weight: 600;
      color: #64748B;
      text-transform: uppercase;
      margin-bottom: 6px;
    }
    .metric-value {
      font-size: 26px;
      font-weight: 700;
      line-height: 1.1;
    }
    .metric-sub {
      font-size: 11px;
      color: #64748B;
      margin-top: 4px;
    }
    .narrative-card {
      border: 1px solid #CBD5E1;
      border-left: 4px solid #1E2A4A;
      border-radius: 4px;
      padding: 16px 20px;
      background: #FFFFFF;
      margin-bottom: 24px;
      font-size: 13px;
      color: #334155;
    }
    h2 {
      font-size: 16px;
      font-weight: 700;
      color: #1E2A4A;
      border-bottom: 2px solid #E2E8F0;
      padding-bottom: 6px;
      margin-top: 24px;
      margin-bottom: 14px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin-bottom: 24px;
      font-size: 12px;
    }
    th, td {
      border: 1px solid #E2E8F0;
      padding: 10px 12px;
      text-align: left;
      vertical-align: top;
    }
    th {
      background: #F1F5F9;
      color: #1E2A4A;
      font-weight: 600;
      font-size: 11px;
      text-transform: uppercase;
    }
    .badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
    }
    .badge-priority {
      background: #1E2A4A;
      color: #FFFFFF;
    }
    .text-center { text-align: center; }
    .text-muted { color: #64748B; font-size: 11px; }
    .code-col { font-family: monospace; font-size: 11px; }
    .score-cell { font-weight: 700; text-align: center; }
    .signature-section {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 20px;
      margin-top: 30px;
      page-break-inside: avoid;
    }
    .signature-box {
      border: 1px solid #E2E8F0;
      border-radius: 8px;
      padding: 16px 20px;
      background: #F8FAFC;
      position: relative;
    }
    .signature-box.approved {
      border-color: #0FB5A5;
      background: #F0FDF4;
    }
    .signature-box.pending {
      border-color: #64748B;
      background: #FEFCE8;
    }
    .sig-header {
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.5px;
      margin-bottom: 8px;
    }
    .sig-name { font-size: 14px; margin-bottom: 2px; }
    .sig-role { font-size: 12px; color: #475569; margin-bottom: 8px; }
    .sig-meta { font-size: 10px; color: #64748B; font-family: monospace; }
    .review-badge {
      position: absolute;
      top: 14px;
      right: 14px;
      background: #0FB5A5;
      color: #FFFFFF;
      font-size: 9px;
      font-weight: 800;
      padding: 4px 8px;
      border-radius: 3px;
      letter-spacing: 0.5px;
    }
    .audit-footer {
      margin-top: 30px;
      border-top: 1px solid #E2E8F0;
      padding-top: 12px;
      font-size: 10px;
      color: #94A3B8;
      display: block;
      page-break-inside: avoid;
    }
    .audit-footer div { margin-bottom: 4px; }
    .audit-footer .code-col { overflow-wrap: anywhere; word-break: break-all; }
    .findings-table { table-layout: fixed; }
    .findings-table td { overflow-wrap: anywhere; }
    @media print {
      .findings-table { font-size: 11px; line-height: 1.35; }
      .findings-table th, .findings-table td { padding: 8px 6px; }
      .findings-table .text-muted { font-size: 10px; }
      .findings-table .badge { padding: 2px 4px; font-size: 9px; white-space: nowrap; }
      body { font-size: 11pt; }
      .header-banner { margin-bottom: 12pt; padding: 16pt; }
      .page-break { page-break-before: always; }
      tr { page-break-inside: avoid; }
    }
  </style>
</head>
<body>
  <div class="header-banner">
    <div>
      <h1 class="brand-title">${escapeHtml(validated.title)}</h1>
      <p class="brand-subtitle">${escapeHtml(validated.branding.product)} · ${escapeHtml(validated.branding.company)} · Generated ${escapeHtml(validated.generated_at)}</p>
    </div>
    <div>
      <span class="report-badge">Board Draft</span>
    </div>
  </div>

  <div class="summary-grid">
    <div class="metric-card">
      <div class="metric-title">${scoreTitle}</div>
      <div class="metric-value" style="color: ${scoreColor};">${es.posture_score}%</div>
      <div class="metric-sub">${scoreDetail}</div>
    </div>
    <div class="metric-card">
      <div class="metric-title">Estimated Exposure</div>
      <div class="metric-value" style="color: #64748B;">${formatInr(es.estimated_exposure_inr)}</div>
      <div class="metric-sub">Provisional computation estimate; review required</div>
    </div>
    <div class="metric-card">
      <div class="metric-title">${reviewTitle}</div>
      <div class="metric-value" style="color: #64748B;">
        ${reviewValue}
      </div>
      <div class="metric-sub">${reviewDetail}</div>
    </div>
    <div class="metric-card">
      <div class="metric-title">Control Library</div>
      <div class="metric-value" style="font-size: 18px; color: #1E2A4A;">${escapeHtml(validated.library_version)}</div>
      <div class="metric-sub">Frozen assessment library version</div>
    </div>
  </div>

  <div class="narrative-card" role="note">${escapeHtml(provenanceNotice)}</div>
  <h2>Executive Summary</h2>
  <div class="narrative-card">
    ${escapeHtml(es.narrative)}
  </div>

  <h2>Recorded Findings &amp; Assessment Review</h2>
  <p class="text-muted">Control priority comes from the frozen library; it does not establish a failure or a verified compliance gap.</p>
  <table class="findings-table">
    <thead>
      <tr>
        <th style="width: 9%;">Control ID</th>
        <th style="width: 11%;">Control Priority</th>
        <th style="width: 17%;">Title &amp; Domain</th>
        <th style="width: 15%;">Score</th>
        <th style="width: 22%;">Recorded Rationale</th>
        <th style="width: 26%;">Review Next Step</th>
      </tr>
    </thead>
    <tbody>
      ${findingsHtml}
    </tbody>
  </table>

  <h2>Remediation Action Plan</h2>
  ${
    validated.action_plan.length === 0
      ? '<p class="text-muted">No reviewed action plan is attached to this assessment.</p>'
      : `<table>
    <thead>
      <tr>
        <th style="width: 50px;" class="text-center">Step</th>
        <th>Remediation Item</th>
        <th style="width: 140px;">Owner</th>
        <th style="width: 100px;" class="text-center">Timeline</th>
        <th style="width: 90px;" class="text-center">Priority</th>
      </tr>
    </thead>
    <tbody>
      ${actionPlanHtml}
    </tbody>
  </table>`
  }

  <h2>Preparation and Review</h2>
  <div class="signature-section">
    <div class="signature-box approved">
      <div class="sig-header" style="color: #0FB5A5;">${preparedByRenderer ? 'AUTOMATED DRAFT' : 'PREPARED BY AGENT'}</div>
      <div class="sig-name"><strong>${escapeHtml(validated.signatures.prepared_by.name)}</strong></div>
      <div class="sig-role">${escapeHtml(validated.signatures.prepared_by.role)}</div>
      <div class="sig-meta">${preparedByRenderer ? 'Generated from a recorded assessment' : 'Authority: Synthesis &amp; Drafting'}</div>
      <div class="sig-meta">${preparedByRenderer ? 'Requires founder review before release' : 'Non-Mutating Inspection'}</div>
    </div>
    ${approvalBlockHtml}
  </div>

  <div class="audit-footer">
    <div><strong>Assessment Packet Digest:</strong> <span class="code-col">${escapeHtml(validated.assessment_result_digest)}</span></div>
    <div><strong>Library Digest:</strong> <span class="code-col">${escapeHtml(validated.library_digest)}</span></div>
    <div><strong>Platform:</strong> ${escapeHtml(validated.branding.company_url)}</div>
  </div>
${validated.schema_version >= 3 && 'public_review_appendix' in validated ? renderPublicControlReportAppendix(validated.public_review_appendix, validated.schema_version === 4 ? validated.asset_scope : undefined) : ''}</body>
</html>`;
}
