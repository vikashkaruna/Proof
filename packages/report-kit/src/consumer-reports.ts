/**
 * Consumer Reports contracts, schema validation, and deterministic HTML rendering
 * for DSAR responses, Breach notifications, and Gap-scan reports under DPDPA 2023.
 * Strictly adheres to Axiom Minds branding defaults and regulatory audit standards.
 */
import { z } from 'zod';
import { BRANDING } from './schema';

const uuid = z.string().regex(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
const timestamp = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/)
  .refine((v) => Number.isFinite(Date.parse(v)));

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ─── 1. DSAR Response Report ──────────────────────────────────────────

export const DsarResponseContentV1Schema = z.object({
  schema_version: z.literal(1),
  kind: z.literal('dsar_response'),
  dsar_id: uuid,
  tenant_id: uuid,
  request_kind: z.enum(['access', 'correction', 'erasure', 'nomination']),
  data_principal_name: z.string().min(1).max(200),
  data_principal_identifier: z.string().min(1).max(200),
  identity_verification_method: z.string().min(1).max(200),
  identity_verified_at: timestamp,
  status: z.enum(['fulfilled', 'rejected', 'partial']),
  fulfilment_summary: z.string().min(10).max(5000),
  data_categories_processed: z.array(z.string().min(1).max(100)),
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
  dpo_officer: z.object({
    name: z.string().min(1).max(100),
    title: z.string().min(1).max(100),
    email: z.string().email(),
  }),
  signatures: z.object({
    prepared_by: z.object({
      name: z.string().min(1).max(100),
      role: z.string().min(1).max(100),
      agent: z.literal('prativedan'),
    }),
    approved_by: z.object({
      user_id: uuid,
      name: z.string().min(1).max(100),
      role: z.string().min(1).max(100),
      timestamp: timestamp,
    }),
  }),
});
export type DsarResponseContentV1 = z.infer<typeof DsarResponseContentV1Schema>;

export function renderDsarResponseHtml(content: DsarResponseContentV1): string {
  const v = DsarResponseContentV1Schema.parse(content);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Data Principal Rights Fulfilment Notice — ${escapeHtml(v.branding.product)}</title>
  <style>
    @page { size: A4 portrait; margin: 15mm; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #1E293B; margin: 0; padding: 0; font-size: 13px; line-height: 1.6; }
    .header-banner { background: #1E2A4A; color: #FFFFFF; padding: 22px 28px; border-radius: 8px; display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px; }
    .brand-title { font-size: 20px; font-weight: 700; margin: 0; }
    .badge { background: #0FB5A5; color: #FFFFFF; font-size: 11px; font-weight: 700; padding: 5px 12px; border-radius: 4px; text-transform: uppercase; }
    .info-card { background: #F8FAFC; border: 1px solid #E2E8F0; border-radius: 8px; padding: 16px; margin-bottom: 20px; font-size: 12px; }
    .fulfilment-text { background: #FFFFFF; border: 1px solid #CBD5E1; border-radius: 6px; padding: 16px; margin-bottom: 24px; white-space: pre-wrap; font-size: 13px; }
    .sig-box { border: 1px solid #0FB5A5; background: #F0FDF4; border-radius: 8px; padding: 16px; margin-top: 24px; }
    .footer { margin-top: 40px; padding-top: 12px; border-top: 1px solid #E2E8F0; font-size: 11px; color: #94A3B8; display: flex; justify-content: space-between; }
  </style>
</head>
<body>
  <div class="header-banner">
    <div>
      <div class="brand-title">Data Principal Rights Request Fulfilment</div>
      <p style="margin: 4px 0 0 0; font-size: 11px; color: #94A3B8;">DPDPA 2023 Statutory Communication</p>
    </div>
    <div class="badge">${escapeHtml(v.request_kind.toUpperCase())} FULFILLED</div>
  </div>

  <div class="info-card">
    <strong>Data Principal:</strong> ${escapeHtml(v.data_principal_name)} (${escapeHtml(v.data_principal_identifier)})<br>
    <strong>Request ID:</strong> ${escapeHtml(v.dsar_id)}<br>
    <strong>Identity Verification:</strong> ${escapeHtml(v.identity_verification_method)} (Verified: ${escapeHtml(v.identity_verified_at)})<br>
    <strong>Data Protection Officer:</strong> ${escapeHtml(v.dpo_officer.name)} (${escapeHtml(v.dpo_officer.email)})
  </div>

  <h3 style="color: #1E2A4A; margin-bottom: 8px;">Fulfilment Determination &amp; Actions Taken</h3>
  <div class="fulfilment-text">${escapeHtml(v.fulfilment_summary)}</div>

  <div>
    <strong>Categories of Personal Data Involved:</strong> ${escapeHtml(v.data_categories_processed.join(', '))}
  </div>

  <div class="sig-box">
    <div style="font-size: 11px; font-weight: 700; color: #0FB5A5; margin-bottom: 4px;">✓ VERIFIED AND SIGNED BY AUTHORIZED DPO / COMPLIANCE OFFICER</div>
    <div style="font-size: 14px; font-weight: 700; color: #1E2A4A;">${escapeHtml(v.signatures.approved_by.name)}</div>
    <div style="font-size: 12px; color: #475569;">${escapeHtml(v.signatures.approved_by.role)} · Timestamp: ${escapeHtml(v.signatures.approved_by.timestamp)}</div>
  </div>

  <div class="footer">
    <div>Generated by ${escapeHtml(v.signatures.prepared_by.name)} · ${escapeHtml(v.branding.product)}</div>
    <div>${escapeHtml(v.branding.company)} (${escapeHtml(v.branding.company_url)})</div>
  </div>
</body>
</html>`;
}

// ─── 2. Breach Notification Report ───────────────────────────────────

export const BreachNotificationContentV1Schema = z.object({
  schema_version: z.literal(1),
  kind: z.literal('breach_notification'),
  breach_id: uuid,
  tenant_id: uuid,
  incident_title: z.string().min(1).max(300),
  severity: z.enum(['low', 'medium', 'high', 'critical']),
  discovered_at: timestamp,
  affected_principals_count: z.number().int().min(0),
  data_categories: z.array(z.string().min(1).max(100)),
  technical_summary: z.string().min(10).max(5000),
  containment_actions: z.array(z.string().min(1).max(500)),
  dpb_notified: z.boolean(),
  dpb_notified_at: timestamp.nullable(),
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
  signatures: z.object({
    prepared_by: z.object({
      name: z.string().min(1).max(100),
      role: z.string().min(1).max(100),
      agent: z.literal('prativedan'),
    }),
    incident_lead: z.object({
      name: z.string().min(1).max(100),
      role: z.string().min(1).max(100),
      timestamp: timestamp,
    }),
  }),
});
export type BreachNotificationContentV1 = z.infer<typeof BreachNotificationContentV1Schema>;

export function renderBreachNotificationHtml(content: BreachNotificationContentV1): string {
  const v = BreachNotificationContentV1Schema.parse(content);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(v.incident_title)} — Statutory Breach Report</title>
  <style>
    @page { size: A4 portrait; margin: 15mm; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #1E293B; margin: 0; padding: 0; font-size: 13px; line-height: 1.6; }
    .header-banner { background: #1E2A4A; color: #FFFFFF; padding: 22px 28px; border-radius: 8px; display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px; }
    .brand-title { font-size: 20px; font-weight: 700; margin: 0; }
    .badge { background: #D9534F; color: #FFFFFF; font-size: 11px; font-weight: 700; padding: 5px 12px; border-radius: 4px; text-transform: uppercase; }
    .summary-card { background: #FFF1F2; border: 1px solid #FECDD3; border-radius: 8px; padding: 16px; margin-bottom: 20px; font-size: 12px; }
    .section-title { font-size: 15px; font-weight: 700; color: #1E2A4A; margin: 20px 0 8px 0; border-bottom: 1px solid #E2E8F0; padding-bottom: 4px; }
    .containment-item { background: #F8FAFC; border: 1px solid #E2E8F0; border-radius: 4px; padding: 8px 12px; margin-bottom: 6px; font-size: 12px; }
    .footer { margin-top: 40px; padding-top: 12px; border-top: 1px solid #E2E8F0; font-size: 11px; color: #94A3B8; display: flex; justify-content: space-between; }
  </style>
</head>
<body>
  <div class="header-banner">
    <div>
      <div class="brand-title">${escapeHtml(v.incident_title)}</div>
      <p style="margin: 4px 0 0 0; font-size: 11px; color: #94A3B8;">DPDPA 2023 Section 8(6) Breach Incident Audit Record</p>
    </div>
    <div class="badge">${escapeHtml(v.severity.toUpperCase())} SEVERITY</div>
  </div>

  <div class="summary-card">
    <strong>Incident ID:</strong> ${escapeHtml(v.breach_id)}<br>
    <strong>Discovered At:</strong> ${escapeHtml(v.discovered_at)}<br>
    <strong>Estimated Impact:</strong> ${v.affected_principals_count.toLocaleString()} data principals<br>
    <strong>Categories:</strong> ${escapeHtml(v.data_categories.join(', '))}<br>
    <strong>DPB Notice:</strong> ${v.dpb_notified ? 'Dispatched (' + escapeHtml(v.dpb_notified_at ?? '') + ')' : 'Pending'}
  </div>

  <div class="section-title">Technical Incident Assessment</div>
  <p style="font-size: 13px; color: #334155;">${escapeHtml(v.technical_summary)}</p>

  <div class="section-title">Containment &amp; Remediations Executed</div>
  ${v.containment_actions.map((c) => `<div class="containment-item">✓ ${escapeHtml(c)}</div>`).join('\n')}

  <div class="footer">
    <div>Generated by ${escapeHtml(v.signatures.prepared_by.name)} · Reviewed by ${escapeHtml(v.signatures.incident_lead.name)} (${escapeHtml(v.signatures.incident_lead.role)})</div>
    <div>${escapeHtml(v.branding.product)} · ${escapeHtml(v.branding.company)}</div>
  </div>
</body>
</html>`;
}

// ─── 3. Gap Scan Report ──────────────────────────────────────────────

export const GapScanReportContentV1Schema = z.object({
  schema_version: z.literal(1),
  kind: z.literal('gap_scan_report'),
  scan_id: uuid,
  tenant_id: uuid.optional(),
  target_url: z.string().min(1).max(500),
  overall_score: z.number().min(0).max(100),
  scanned_at: timestamp,
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
  checklist_results: z.array(
    z.object({
      category: z.string().min(1).max(100),
      score: z.number().min(0).max(100),
      findings_count: z.number().int().min(0),
      summary: z.string().min(1).max(1000),
    }),
  ),
  critical_findings: z.array(
    z.object({
      domain: z.string().min(1).max(100),
      title: z.string().min(1).max(200),
      recommendation: z.string().min(1).max(1000),
    }),
  ),
});
export type GapScanReportContentV1 = z.infer<typeof GapScanReportContentV1Schema>;

export function renderGapScanReportHtml(content: GapScanReportContentV1): string {
  const v = GapScanReportContentV1Schema.parse(content);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>DPDPA Gap Scan Assessment — ${escapeHtml(v.target_url)}</title>
  <style>
    @page { size: A4 portrait; margin: 15mm; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #1E293B; margin: 0; padding: 0; font-size: 13px; line-height: 1.6; }
    .header-banner { background: #1E2A4A; color: #FFFFFF; padding: 22px 28px; border-radius: 8px; display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px; }
    .brand-title { font-size: 20px; font-weight: 700; margin: 0; }
    .score-badge { background: ${v.overall_score >= 70 ? '#0FB5A5' : '#D9534F'}; color: #FFFFFF; font-size: 16px; font-weight: 700; padding: 8px 16px; border-radius: 6px; }
    .table-scan { width: 100%; border-collapse: collapse; margin-bottom: 24px; font-size: 12px; }
    .table-scan th, .table-scan td { border: 1px solid #E2E8F0; padding: 10px 12px; text-align: left; }
    .table-scan th { background: #F8FAFC; color: #334155; }
    .footer { margin-top: 40px; padding-top: 12px; border-top: 1px solid #E2E8F0; font-size: 11px; color: #94A3B8; display: flex; justify-content: space-between; }
  </style>
</head>
<body>
  <div class="header-banner">
    <div>
      <div class="brand-title">DPDPA 2023 Gap Scan Report</div>
      <p style="margin: 4px 0 0 0; font-size: 11px; color: #94A3B8;">Target: ${escapeHtml(v.target_url)} · Scanned: ${escapeHtml(v.scanned_at)}</p>
    </div>
    <div class="score-badge">${v.overall_score}% SCORE</div>
  </div>

  <h3 style="color: #1E2A4A;">Statutory Domain Evaluations</h3>
  <table class="table-scan">
    <thead>
      <tr>
        <th>Category</th>
        <th>Score</th>
        <th>Gaps</th>
        <th>Analysis Summary</th>
      </tr>
    </thead>
    <tbody>
      ${v.checklist_results
        .map(
          (c) => `
        <tr>
          <td><strong>${escapeHtml(c.category)}</strong></td>
          <td style="color: ${c.score >= 70 ? '#0FB5A5' : '#D9534F'}; font-weight: 700;">${c.score}%</td>
          <td>${c.findings_count}</td>
          <td>${escapeHtml(c.summary)}</td>
        </tr>
      `,
        )
        .join('\n')}
    </tbody>
  </table>

  ${
    v.critical_findings.length > 0
      ? `
    <h3 style="color: #1E2A4A;">Top Priority Remediations</h3>
    ${v.critical_findings
      .map(
        (f) => `
      <div style="background: #FFFBEB; border: 1px solid #FDE68A; border-radius: 6px; padding: 12px; margin-bottom: 8px; font-size: 12px;">
        <div style="font-weight: 700; color: #92400E;">${escapeHtml(f.title)} (${escapeHtml(f.domain)})</div>
        <div style="color: #78350F; margin-top: 4px;"><strong>Recommended:</strong> ${escapeHtml(f.recommendation)}</div>
      </div>
    `,
      )
      .join('\n')}
  `
      : ''
  }

  <div class="footer">
    <div>Automated Synthesis by ${escapeHtml(v.branding.product)}</div>
    <div>${escapeHtml(v.branding.company)} (${escapeHtml(v.branding.company_url)})</div>
  </div>
</body>
</html>`;
}
