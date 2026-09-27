/**
 * Data Protection Board (DPB) statutory submission contracts, schema validation,
 * and deterministic HTML rendering under Digital Personal Data Protection Act, 2023.
 */
import { z } from 'zod';
import { BRANDING } from './schema';

const uuid = z.string().regex(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const timestamp = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/)
  .refine((v) => Number.isFinite(Date.parse(v)));

export const DpbRemedialMeasureSchema = z.object({
  step: z.number().int().min(1),
  measure: z.string().min(1).max(1000),
  status: z.enum(['completed', 'in_progress', 'planned']),
  verification_evidence_hash: hash.nullable(),
});
export type DpbRemedialMeasure = z.infer<typeof DpbRemedialMeasureSchema>;

export const DpbIncidentDetailsSchema = z.object({
  incident_type: z.string().min(1).max(200),
  detected_at: timestamp,
  estimated_principals_affected: z.number().int().min(0),
  categories_of_personal_data: z.array(z.string().min(1).max(100)).min(1).max(20),
  root_cause_summary: z.string().min(10).max(3000),
  potential_consequences: z.string().min(10).max(3000),
});
export type DpbIncidentDetails = z.infer<typeof DpbIncidentDetailsSchema>;

export const DpbSubmissionContentV1Schema = z.object({
  schema_version: z.literal(1),
  kind: z.literal('dpb_submission'),
  submission_id: uuid.optional(),
  title: z.string().min(1).max(300),
  tenant_id: uuid,
  submission_type: z.enum(['breach_notification', 'statutory_inquiry_response', 'annual_dpdpa_filing']),
  dpb_reference_number: z.string().min(1).max(100).nullable().default(null),
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
  data_fiduciary: z.object({
    legal_name: z.string().min(1).max(200),
    registration_number: z.string().min(1).max(100),
    principal_office: z.string().min(1).max(300),
    dpo_name: z.string().min(1).max(100),
    dpo_email: z.string().email(),
    dpo_phone: z.string().min(5).max(30),
  }),
  incident_details: DpbIncidentDetailsSchema.nullable().default(null),
  statutory_sections_invoked: z.array(z.string().min(1).max(150)).min(1).max(20),
  remedial_measures: z.array(DpbRemedialMeasureSchema).max(30),
  communication_status: z.object({
    board_notified_at: timestamp,
    affected_principals_notified: z.boolean(),
    notification_channels: z.array(z.string().min(1).max(100)),
  }),
  signatures: z.object({
    prepared_by: z.object({
      name: z.string().min(1).max(100),
      role: z.string().min(1).max(100),
      agent: z.literal('prativedan'),
    }),
    dpo_attestation: z.object({
      dpo_name: z.string().min(1).max(100),
      dpo_designation: z.string().min(1).max(100),
      statement: z.string().min(10).max(2000),
      timestamp: timestamp,
    }),
    authorized_signatory: z
      .object({
        user_id: uuid,
        name: z.string().min(1).max(100),
        designation: z.string().min(1).max(100),
        timestamp: timestamp,
      })
      .nullable()
      .default(null),
  }),
});
export type DpbSubmissionContentV1 = z.infer<typeof DpbSubmissionContentV1Schema>;

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderDpbSubmissionHtml(content: DpbSubmissionContentV1): string {
  const validated = DpbSubmissionContentV1Schema.parse(content);

  const remedialMeasuresHtml = validated.remedial_measures
    .map(
      (m) => `
      <tr>
        <td style="width: 8%; text-align: center; font-weight: 700;">${m.step}</td>
        <td>${escapeHtml(m.measure)}</td>
        <td style="width: 15%; text-align: center;">
          <span class="status-pill ${m.status}">${escapeHtml(m.status.toUpperCase())}</span>
        </td>
        <td style="width: 25%; font-family: monospace; font-size: 11px; color: #0284C7;">
          ${m.verification_evidence_hash ? escapeHtml(m.verification_evidence_hash.slice(0, 16)) + '...' : '<span style="color: #94A3B8;">pending</span>'}
        </td>
      </tr>
    `,
    )
    .join('\n');

  const signatoryBlockHtml = validated.signatures.authorized_signatory
    ? `
      <div class="signature-box approved">
        <div class="sig-header" style="color: #0FB5A5;">✓ FORMALLY EXECUTED &amp; SEALED FOR STATUTORY SUBMISSION</div>
        <div class="sig-name"><strong>${escapeHtml(validated.signatures.authorized_signatory.name)}</strong></div>
        <div class="sig-role">${escapeHtml(validated.signatures.authorized_signatory.designation)}</div>
        <div class="sig-meta">Principal ID: ${escapeHtml(validated.signatures.authorized_signatory.user_id)}</div>
        <div class="sig-meta">Execution Timestamp: ${escapeHtml(validated.signatures.authorized_signatory.timestamp)}</div>
        <div class="seal-badge">STATUTORY DPB SEAL</div>
      </div>`
    : `
      <div class="signature-box pending">
        <div class="sig-header" style="color: #C9A227;">⚠ DRAFT STATUTORY FILING · PENDING SIGNATURE</div>
        <div class="sig-role">Requires formal verification and authorization by the Board-appointed Officer.</div>
        <div class="sig-meta">Status: Unsubmitted Draft</div>
      </div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(validated.title)} — DPB Statutory Submission</title>
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
    .brand-title { font-size: 22px; font-weight: 700; margin: 0 0 4px 0; }
    .brand-subtitle { font-size: 11px; color: #94A3B8; margin: 0; }
    .dpb-badge {
      background: #C9A227; color: #1E2A4A; font-size: 11px; font-weight: 700;
      padding: 6px 14px; border-radius: 4px; text-transform: uppercase;
    }
    .fiduciary-grid {
      display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 24px;
      background: #F8FAFC; border: 1px solid #E2E8F0; border-radius: 8px; padding: 18px;
    }
    .fiduciary-item { font-size: 12px; }
    .fiduciary-item strong { color: #1E2A4A; }
    .section-title {
      font-size: 15px; font-weight: 700; color: #1E2A4A; margin: 24px 0 10px 0;
      padding-bottom: 6px; border-bottom: 2px solid #E2E8F0;
    }
    .table-custom {
      width: 100%; border-collapse: collapse; margin-top: 10px; font-size: 12px;
    }
    .table-custom th, .table-custom td {
      border: 1px solid #E2E8F0; padding: 10px 12px; text-align: left;
    }
    .table-custom th { background: #F1F5F9; color: #334155; font-weight: 600; }
    .status-pill { font-size: 10px; font-weight: 700; padding: 3px 6px; border-radius: 4px; }
    .status-pill.completed { background: #D1FAE5; color: #065F46; }
    .status-pill.in_progress { background: #FEF3C7; color: #92400E; }
    .status-pill.planned { background: #F1F5F9; color: #475569; }
    .statutory-tags { display: flex; flex-wrap: wrap; gap: 8px; margin: 10px 0; }
    .statutory-tag {
      background: #EEF2F6; border: 1px solid #CBD5E1; color: #1E2A4A;
      font-size: 11px; font-weight: 600; padding: 4px 10px; border-radius: 4px;
    }
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
      <p class="brand-subtitle">DPDPA 2023 Statutory Submission to the Data Protection Board of India</p>
    </div>
    <div class="dpb-badge">DPB FORM SUBMISSION</div>
  </div>

  <div class="fiduciary-grid">
    <div class="fiduciary-item">
      <strong>Data Fiduciary:</strong> ${escapeHtml(validated.data_fiduciary.legal_name)}<br>
      <strong>Registration/CIN:</strong> ${escapeHtml(validated.data_fiduciary.registration_number)}<br>
      <strong>Registered Office:</strong> ${escapeHtml(validated.data_fiduciary.principal_office)}
    </div>
    <div class="fiduciary-item">
      <strong>Data Protection Officer:</strong> ${escapeHtml(validated.data_fiduciary.dpo_name)}<br>
      <strong>DPO Email:</strong> ${escapeHtml(validated.data_fiduciary.dpo_email)}<br>
      <strong>DPO Phone:</strong> ${escapeHtml(validated.data_fiduciary.dpo_phone)}<br>
      <strong>DPB Ref:</strong> ${validated.dpb_reference_number ? escapeHtml(validated.dpb_reference_number) : 'NEW SUBMISSION'}
    </div>
  </div>

  <div class="section-title">Statutory Mandate &amp; Provisions Invoked</div>
  <div class="statutory-tags">
    ${validated.statutory_sections_invoked.map((s) => `<span class="statutory-tag">${escapeHtml(s)}</span>`).join('\n')}
  </div>

  ${
    validated.incident_details
      ? `
    <div class="section-title">Incident Particulars &amp; Impact Assessment</div>
    <div style="background: #FFFBEB; border: 1px solid #FDE68A; border-radius: 8px; padding: 14px; margin-bottom: 16px; font-size: 12px;">
      <p style="margin: 0 0 6px 0;"><strong>Incident Nature:</strong> ${escapeHtml(validated.incident_details.incident_type)} · <strong>Detected at:</strong> ${escapeHtml(validated.incident_details.detected_at)}</p>
      <p style="margin: 0 0 6px 0;"><strong>Estimated Data Principals Impacted:</strong> ${validated.incident_details.estimated_principals_affected.toLocaleString()}</p>
      <p style="margin: 0 0 6px 0;"><strong>Categories of Personal Data Involved:</strong> ${escapeHtml(validated.incident_details.categories_of_personal_data.join(', '))}</p>
      <p style="margin: 0 0 6px 0;"><strong>Root Cause Analysis:</strong> ${escapeHtml(validated.incident_details.root_cause_summary)}</p>
      <p style="margin: 0;"><strong>Potential Consequences:</strong> ${escapeHtml(validated.incident_details.potential_consequences)}</p>
    </div>
  `
      : ''
  }

  <div class="section-title">Remedial Actions &amp; Technical Safeguards Implemented</div>
  <table class="table-custom">
    <thead>
      <tr>
        <th>Step</th>
        <th>Remedial Measure</th>
        <th>Status</th>
        <th>Evidence Digest</th>
      </tr>
    </thead>
    <tbody>
      ${remedialMeasuresHtml}
    </tbody>
  </table>

  <div class="section-title">Communication &amp; Notice Particulars</div>
  <div style="font-size: 12px; color: #334155; margin-bottom: 20px;">
    Board Notification Initiated: <strong>${escapeHtml(validated.communication_status.board_notified_at)}</strong> · 
    Affected Principals Notified: <strong>${validated.communication_status.affected_principals_notified ? 'YES' : 'NO'}</strong> · 
    Channels: <strong>${escapeHtml(validated.communication_status.notification_channels.join(', '))}</strong>
  </div>

  <div class="section-title">Statutory Declarations &amp; Verification</div>
  <div class="signatures-container">
    <div class="signature-box">
      <div class="sig-header" style="color: #1E2A4A;">DATA PROTECTION OFFICER VERIFICATION</div>
      <div class="sig-name"><strong>${escapeHtml(validated.signatures.dpo_attestation.dpo_name)}</strong></div>
      <div class="sig-role">${escapeHtml(validated.signatures.dpo_attestation.dpo_designation)}</div>
      <div class="sig-meta" style="margin: 8px 0; font-style: italic;">"${escapeHtml(validated.signatures.dpo_attestation.statement)}"</div>
      <div class="sig-meta">Timestamp: ${escapeHtml(validated.signatures.dpo_attestation.timestamp)}</div>
    </div>
    ${signatoryBlockHtml}
  </div>

  <div class="footer">
    <div>Generated by ${escapeHtml(validated.signatures.prepared_by.name)} · ${escapeHtml(validated.branding.product)}</div>
    <div>Submission Date: ${escapeHtml(validated.generated_at)}</div>
  </div>
</body>
</html>`;
}
