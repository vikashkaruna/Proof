/**
 * Board Report contracts, schema validation, and deterministic HTML rendering.
 * Strictly adheres to Axiom Proof design tokens and regulatory DPDPA standards.
 */
import { z } from 'zod';
import { BRANDING } from './schema';

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
export function renderBoardReportHtml(content: BoardReportContentV1): string {
  const validated = BoardReportContentV1Schema.parse(content);
  const preparedByRenderer = validated.signatures.prepared_by.agent === 'board-report-builder';
  const es = validated.executive_summary;
  const scoreColor =
    es.posture_score >= 80 ? '#0FB5A5' : es.posture_score >= 60 ? '#64748B' : '#D9534F';

  const findingsHtml = validated.key_findings
    .map((f) => {
      const sevColor =
        f.severity === 'critical'
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
        <td class="score-cell">${f.score}%</td>
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
    @media print {
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
      <div class="metric-title">Posture Score</div>
      <div class="metric-value" style="color: ${scoreColor};">${es.posture_score}%</div>
      <div class="metric-sub">${es.passed_controls} / ${es.total_controls} controls scoring at least 80</div>
    </div>
    <div class="metric-card">
      <div class="metric-title">Estimated Exposure</div>
      <div class="metric-value" style="color: #D9534F;">${formatInr(es.estimated_exposure_inr)}</div>
      <div class="metric-sub">Recorded heuristic estimate</div>
    </div>
    <div class="metric-card">
      <div class="metric-title">Critical & High Gaps</div>
      <div class="metric-value" style="color: ${es.critical_gaps + es.high_gaps > 0 ? '#D9534F' : '#0FB5A5'};">
        ${es.critical_gaps + es.high_gaps}
      </div>
      <div class="metric-sub">${es.critical_gaps} Critical · ${es.high_gaps} High</div>
    </div>
    <div class="metric-card">
      <div class="metric-title">Control Library</div>
      <div class="metric-value" style="font-size: 18px; color: #1E2A4A;">${escapeHtml(validated.library_version)}</div>
      <div class="metric-sub">Frozen assessment library version</div>
    </div>
  </div>

  <h2>Executive Summary</h2>
  <div class="narrative-card">
    ${escapeHtml(es.narrative)}
  </div>

  <h2>Key Findings &amp; Regulatory Gaps</h2>
  <table>
    <thead>
      <tr>
        <th style="width: 100px;">Control ID</th>
        <th style="width: 80px;">Severity</th>
        <th style="width: 200px;">Title &amp; Domain</th>
        <th style="width: 60px;">Score</th>
        <th>Gap Summary</th>
        <th>Remediation Recommendation</th>
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
</body>
</html>`;
}
