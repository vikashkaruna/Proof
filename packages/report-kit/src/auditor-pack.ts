/**
 * Auditor Pack contracts, schema validation, and deterministic HTML rendering.
 * Provides formal regulatory and independent audit evidence compilation under DPDPA 2023.
 */
import { z } from 'zod';
import { BRANDING } from './schema';

const uuid = z.string().regex(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const timestamp = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/)
  .refine((v) => Number.isFinite(Date.parse(v)));

export const AuditorEvidenceReferenceSchema = z.object({
  evidence_id: uuid,
  receipt_id: uuid,
  content_hash: hash,
  collected_by: z.string().min(1).max(100),
  collected_at: timestamp,
  provenance: z.enum(['human_submitted', 'unknown', 'production', 'reference', 'sandbox']),
});
export type AuditorEvidenceReference = z.infer<typeof AuditorEvidenceReferenceSchema>;

export const AuditorControlEvaluationSchema = z.object({
  control_id: z.string().min(1).max(100),
  title: z.string().min(1).max(300),
  domain: z.string().min(1).max(100),
  statutory_reference: z.string().min(1).max(150),
  status: z.enum(['compliant', 'partially_compliant', 'non_compliant', 'not_applicable']),
  score: z.number().min(0).max(100),
  auditor_notes: z.string().min(1).max(2000),
  evidence_references: z.array(AuditorEvidenceReferenceSchema).max(20),
});
export type AuditorControlEvaluation = z.infer<typeof AuditorControlEvaluationSchema>;

export const AuditorPackContentV1Schema = z.object({
  schema_version: z.literal(1),
  kind: z.literal('auditor_pack'),
  pack_id: uuid.optional(),
  title: z.string().min(1).max(300),
  tenant_id: uuid,
  engagement_id: uuid,
  assessment_run_id: uuid,
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
  audit_metadata: z.object({
    audit_firm_or_internal: z.string().min(1).max(200),
    lead_auditor_name: z.string().min(1).max(100),
    period_start: timestamp,
    period_end: timestamp,
    scope_description: z.string().min(10).max(2000),
  }),
  compliance_metrics: z.object({
    posture_score: z.number().min(0).max(100),
    total_controls_audited: z.number().int().min(0),
    compliant_controls: z.number().int().min(0),
    partially_compliant_controls: z.number().int().min(0),
    non_compliant_controls: z.number().int().min(0),
    not_applicable_controls: z.number().int().min(0),
    evidence_items_reviewed: z.number().int().min(0),
  }),
  control_evaluations: z.array(AuditorControlEvaluationSchema).max(100),
  signatures: z.object({
    prepared_by: z.object({
      name: z.string().min(1).max(100),
      role: z.string().min(1).max(100),
      agent: z.literal('prativedan'),
    }),
    auditor_attestation: z.object({
      auditor_name: z.string().min(1).max(100),
      firm: z.string().min(1).max(200),
      designation: z.string().min(1).max(100),
      attestation_statement: z.string().min(10).max(2000),
      timestamp: timestamp,
    }),
    approved_by: z
      .object({
        user_id: uuid,
        name: z.string().min(1).max(100),
        role: z.string().min(1).max(100),
        timestamp: timestamp,
      })
      .nullable()
      .default(null),
  }),
});
export type AuditorPackContentV1 = z.infer<typeof AuditorPackContentV1Schema>;

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderAuditorPackHtml(content: AuditorPackContentV1): string {
  const validated = AuditorPackContentV1Schema.parse(content);

  const statusBadge = (status: string) => {
    switch (status) {
      case 'compliant':
        return '<span class="status-chip compliant">COMPLIANT</span>';
      case 'partially_compliant':
        return '<span class="status-chip partial">PARTIAL</span>';
      case 'non_compliant':
        return '<span class="status-chip non-compliant">NON-COMPLIANT</span>';
      default:
        return '<span class="status-chip not-applicable">N/A</span>';
    }
  };

  const evaluationsHtml = validated.control_evaluations
    .map(
      (ev) => `
      <div class="eval-card">
        <div class="eval-header">
          <div>
            <span class="control-id">${escapeHtml(ev.control_id)}</span>
            <span class="control-ref">${escapeHtml(ev.statutory_reference)}</span>
            <span class="control-domain">${escapeHtml(ev.domain)}</span>
          </div>
          <div>${statusBadge(ev.status)}</div>
        </div>
        <div class="eval-title">${escapeHtml(ev.title)} (Score: ${ev.score}/100)</div>
        <div class="eval-notes"><strong>Auditor Assessment:</strong> ${escapeHtml(ev.auditor_notes)}</div>
        ${
          ev.evidence_references.length > 0
            ? `
          <div class="evidence-list">
            <div class="evidence-header">Linked Verified Evidence Artifacts (${ev.evidence_references.length}):</div>
            ${ev.evidence_references
              .map(
                (ref) => `
              <div class="evidence-item">
                <span class="ev-id">ID: ${escapeHtml(ref.evidence_id.slice(0, 8))}...</span>
                <span class="ev-hash" title="${escapeHtml(ref.content_hash)}">SHA: ${escapeHtml(ref.content_hash.slice(0, 16))}...</span>
                <span class="ev-provenance">[${escapeHtml(ref.provenance)}]</span>
                <span class="ev-agent">by ${escapeHtml(ref.collected_by)}</span>
              </div>
            `,
              )
              .join('\n')}
          </div>
        `
            : '<div class="no-evidence">No linked evidence attached for this control.</div>'
        }
      </div>
    `,
    )
    .join('\n');

  const approvalBlockHtml = validated.signatures.approved_by
    ? `
      <div class="signature-box approved">
        <div class="sig-header" style="color: #0FB5A5;">✓ APPROVED &amp; RELEASED BY TENANT FOUNDER</div>
        <div class="sig-name"><strong>${escapeHtml(validated.signatures.approved_by.name)}</strong></div>
        <div class="sig-role">${escapeHtml(validated.signatures.approved_by.role)}</div>
        <div class="sig-meta">User ID: ${escapeHtml(validated.signatures.approved_by.user_id)}</div>
        <div class="sig-meta">Timestamp: ${escapeHtml(validated.signatures.approved_by.timestamp)}</div>
        <div class="seal-badge">SEALED AUDIT PROOF</div>
      </div>`
    : `
      <div class="signature-box pending">
        <div class="sig-header" style="color: #C9A227;">⚠ DRAFT AUDIT PACK · PENDING RELEASE</div>
        <div class="sig-role">Requires formal verification and release authorization by the authorized compliance lead.</div>
        <div class="sig-meta">Status: Unreleased Draft</div>
      </div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(validated.title)} — ${escapeHtml(validated.branding.product)}</title>
  <style>
    @page { size: A4 portrait; margin: 15mm; }
    *, *::before, *::after { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      color: #1E293B; background: #FFFFFF; margin: 0; padding: 0; font-size: 13px; line-height: 1.5;
    }
    .header-banner {
      background: #1E2A4A; color: #FFFFFF; padding: 24px 30px; border-radius: 8px;
      display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px;
    }
    .brand-title { font-size: 24px; font-weight: 700; letter-spacing: -0.5px; margin: 0 0 6px 0; }
    .brand-subtitle { font-size: 12px; color: #94A3B8; margin: 0; }
    .report-badge {
      background: #C9A227; color: #1E2A4A; font-size: 11px; font-weight: 700;
      padding: 6px 14px; border-radius: 4px; text-transform: uppercase; letter-spacing: 0.5px;
    }
    .summary-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; margin-bottom: 24px; }
    .metric-card { border: 1px solid #E2E8F0; border-radius: 8px; padding: 16px; background: #F8FAFC; }
    .metric-title { font-size: 11px; font-weight: 600; color: #64748B; text-transform: uppercase; margin-bottom: 6px; }
    .metric-value { font-size: 26px; font-weight: 700; line-height: 1.1; }
    .metric-sub { font-size: 11px; color: #64748B; margin-top: 4px; }
    .section-title {
      font-size: 16px; font-weight: 700; color: #1E2A4A; margin: 28px 0 12px 0;
      padding-bottom: 6px; border-bottom: 2px solid #E2E8F0;
    }
    .audit-meta-box {
      background: #F1F5F9; border-left: 4px solid #0FB5A5; padding: 14px 18px;
      border-radius: 0 8px 8px 0; margin-bottom: 24px; font-size: 12px;
    }
    .eval-card { border: 1px solid #E2E8F0; border-radius: 8px; padding: 16px; margin-bottom: 14px; background: #FFFFFF; page-break-inside: avoid; }
    .eval-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
    .control-id { font-weight: 700; color: #1E2A4A; font-size: 13px; margin-right: 8px; }
    .control-ref { background: #EEF2F6; color: #475569; padding: 2px 6px; border-radius: 4px; font-size: 11px; margin-right: 8px; }
    .control-domain { color: #64748B; font-size: 12px; }
    .status-chip { font-size: 10px; font-weight: 700; padding: 3px 8px; border-radius: 4px; text-transform: uppercase; }
    .status-chip.compliant { background: #D1FAE5; color: #065F46; }
    .status-chip.partial { background: #FEF3C7; color: #92400E; }
    .status-chip.non-compliant { background: #FEE2E2; color: #991B1B; }
    .status-chip.not-applicable { background: #F1F5F9; color: #475569; }
    .eval-title { font-weight: 600; font-size: 13px; color: #0F172A; margin-bottom: 6px; }
    .eval-notes { font-size: 12px; color: #334155; margin-bottom: 8px; }
    .evidence-list { background: #F8FAFC; border: 1px dashed #CBD5E1; border-radius: 6px; padding: 10px 14px; font-size: 11px; }
    .evidence-header { font-weight: 600; color: #475569; margin-bottom: 4px; }
    .evidence-item { display: flex; gap: 8px; font-family: monospace; color: #334155; margin-top: 2px; }
    .ev-hash { color: #0284C7; }
    .ev-provenance { color: #0FB5A5; font-weight: 600; }
    .signatures-container { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-top: 30px; page-break-inside: avoid; }
    .signature-box { border: 1px solid #CBD5E1; border-radius: 8px; padding: 16px; background: #F8FAFC; }
    .signature-box.approved { border-color: #0FB5A5; background: #F0FDF4; }
    .sig-header { font-size: 11px; font-weight: 700; margin-bottom: 8px; }
    .sig-name { font-size: 14px; color: #1E2A4A; }
    .sig-role { font-size: 12px; color: #475569; margin-bottom: 6px; }
    .sig-meta { font-size: 11px; color: #64748B; }
    .seal-badge { display: inline-block; margin-top: 8px; background: #C9A227; color: #1E2A4A; font-weight: 700; font-size: 10px; padding: 2px 8px; border-radius: 4px; }
    .footer { margin-top: 40px; padding-top: 14px; border-top: 1px solid #E2E8F0; display: flex; justify-content: space-between; font-size: 11px; color: #94A3B8; }
  </style>
</head>
<body>
  <div class="header-banner">
    <div>
      <div class="brand-title">${escapeHtml(validated.title)}</div>
      <p class="brand-subtitle">${escapeHtml(validated.branding.product)} · ${escapeHtml(validated.branding.company)} · ${escapeHtml(validated.branding.company_url)}</p>
    </div>
    <div class="report-badge">AUDITOR PACK</div>
  </div>

  <div class="audit-meta-box">
    <strong>Auditing Organization:</strong> ${escapeHtml(validated.audit_metadata.audit_firm_or_internal)} · 
    <strong>Lead Auditor:</strong> ${escapeHtml(validated.audit_metadata.lead_auditor_name)} · 
    <strong>Evaluation Period:</strong> ${escapeHtml(validated.audit_metadata.period_start.slice(0, 10))} to ${escapeHtml(validated.audit_metadata.period_end.slice(0, 10))}<br>
    <strong>Audit Scope:</strong> ${escapeHtml(validated.audit_metadata.scope_description)}
  </div>

  <div class="summary-grid">
    <div class="metric-card">
      <div class="metric-title">Compliance Posture</div>
      <div class="metric-value" style="color: ${validated.compliance_metrics.posture_score >= 80 ? '#0FB5A5' : '#D9534F'};">${validated.compliance_metrics.posture_score}%</div>
      <div class="metric-sub">${validated.compliance_metrics.compliant_controls} of ${validated.compliance_metrics.total_controls_audited} fully compliant</div>
    </div>
    <div class="metric-card">
      <div class="metric-title">Controls Audited</div>
      <div class="metric-value" style="color: #1E2A4A;">${validated.compliance_metrics.total_controls_audited}</div>
      <div class="metric-sub">statutory obligations evaluated</div>
    </div>
    <div class="metric-card">
      <div class="metric-title">Non-Compliant Gaps</div>
      <div class="metric-value" style="color: #D9534F;">${validated.compliance_metrics.non_compliant_controls}</div>
      <div class="metric-sub">${validated.compliance_metrics.partially_compliant_controls} partially compliant</div>
    </div>
    <div class="metric-card">
      <div class="metric-title">Evidence Artifacts</div>
      <div class="metric-value" style="color: #0FB5A5;">${validated.compliance_metrics.evidence_items_reviewed}</div>
      <div class="metric-sub">cryptographically sealed &amp; verified</div>
    </div>
  </div>

  <div class="section-title">Control Evaluations &amp; Evidence Audit Trail</div>
  ${evaluationsHtml}

  <div class="section-title">Attestation &amp; Sign-off</div>
  <div class="signatures-container">
    <div class="signature-box">
      <div class="sig-header" style="color: #1E2A4A;">INDEPENDENT AUDITOR ATTESTATION</div>
      <div class="sig-name"><strong>${escapeHtml(validated.signatures.auditor_attestation.auditor_name)}</strong></div>
      <div class="sig-role">${escapeHtml(validated.signatures.auditor_attestation.designation)} · ${escapeHtml(validated.signatures.auditor_attestation.firm)}</div>
      <div class="sig-meta" style="margin: 8px 0; font-style: italic;">"${escapeHtml(validated.signatures.auditor_attestation.attestation_statement)}"</div>
      <div class="sig-meta">Attested at: ${escapeHtml(validated.signatures.auditor_attestation.timestamp)}</div>
    </div>
    ${approvalBlockHtml}
  </div>

  <div class="footer">
    <div>Generated by ${escapeHtml(validated.signatures.prepared_by.name)} · Library ${escapeHtml(validated.library_version)} (${escapeHtml(validated.library_digest.slice(0, 12))})</div>
    <div>Assessment Digest: ${escapeHtml(validated.assessment_result_digest.slice(0, 16))}...</div>
  </div>
</body>
</html>`;
}
