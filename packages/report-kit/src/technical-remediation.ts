/**
 * Technical Remediation Register contracts, schema validation, and deterministic HTML rendering.
 * Provides formal engineering and DevOps auditability for all remediation actions, dry runs,
 * rollback assurances, and cryptographic execution proofs.
 */
import { z } from 'zod';
import { BRANDING } from './schema';

const uuid = z.string().regex(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
const timestamp = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/)
  .refine((v) => Number.isFinite(Date.parse(v)));

export const TechnicalActionItemSchema = z.object({
  action_id: uuid,
  sequence: z.number().int().min(1),
  action_type: z.string().min(1).max(100),
  description: z.string().min(1).max(1000),
  risk_class: z.enum(['low', 'medium', 'high', 'critical']),
  risk_score: z.number().min(0).max(100),
  target_systems: z.array(z.string().min(1).max(100)),
  blast_radius_records: z.number().int().min(0),
  dry_run_status: z.string().min(1).max(50),
  dry_run_completed_at: timestamp.nullable(),
  rollback_validated: z.boolean(),
  rollback_time_seconds: z.number().int().min(0),
  approval_status: z.string().min(1).max(50),
  approved_by: z.string().nullable(),
  execution_outcome: z.string().nullable(),
  idempotency_key: z.string().min(1).max(100),
});
export type TechnicalActionItem = z.infer<typeof TechnicalActionItemSchema>;

export const TechnicalRemediationRegisterContentV1Schema = z.object({
  schema_version: z.literal(1),
  kind: z.literal('technical_remediation_register'),
  register_id: uuid.optional(),
  title: z.string().min(1).max(300),
  tenant_id: uuid,
  plan_id: uuid,
  plan_version: z.number().int().min(1),
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
  register_summary: z.object({
    total_actions: z.number().int().min(0),
    approved_actions: z.number().int().min(0),
    dry_run_passed_actions: z.number().int().min(0),
    rollback_validated_actions: z.number().int().min(0),
    executed_actions: z.number().int().min(0),
    estimated_total_rollback_time_seconds: z.number().int().min(0),
  }),
  actions: z.array(TechnicalActionItemSchema).max(100),
  signatures: z.object({
    prepared_by: z.object({
      name: z.string().min(1).max(100),
      role: z.string().min(1).max(100),
      agent: z.literal('prativedan'),
    }),
    reviewed_by: z
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
export type TechnicalRemediationRegisterContentV1 = z.infer<typeof TechnicalRemediationRegisterContentV1Schema>;

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderTechnicalRemediationRegisterHtml(
  content: TechnicalRemediationRegisterContentV1,
): string {
  const validated = TechnicalRemediationRegisterContentV1Schema.parse(content);

  const actionRowsHtml = validated.actions
    .map(
      (a) => `
      <tr>
        <td style="text-align: center; font-weight: 700;">#${a.sequence}</td>
        <td>
          <div style="font-weight: 600; color: #1E2A4A;">${escapeHtml(a.action_type)}</div>
          <div style="color: #475569; font-size: 11px;">${escapeHtml(a.description)}</div>
          <div style="font-size: 10px; color: #64748B; margin-top: 2px;">
            Targets: ${escapeHtml(a.target_systems.join(', ') || 'estate-default')} · Records: ${a.blast_radius_records}
          </div>
        </td>
        <td style="text-align: center;">
          <span class="badge ${a.risk_class}">${escapeHtml(a.risk_class.toUpperCase())}</span>
        </td>
        <td style="font-size: 11px;">
          <div>Dry Run: <strong style="color: ${a.dry_run_status === 'passed' ? '#0FB5A5' : '#D9534F'};">${escapeHtml(a.dry_run_status)}</strong></div>
          <div>Rollback: <strong style="color: ${a.rollback_validated ? '#0FB5A5' : '#D9534F'};">${a.rollback_validated ? 'Validated (' + a.rollback_time_seconds + 's)' : 'Not Validated'}</strong></div>
        </td>
        <td style="font-size: 11px;">
          <div>Status: <strong>${escapeHtml(a.approval_status)}</strong></div>
          ${a.approved_by ? `<div style="font-size: 10px; color: #64748B;">By: ${escapeHtml(a.approved_by)}</div>` : ''}
          ${a.execution_outcome ? `<div style="font-size: 10px; color: #0FB5A5; font-weight: 600;">Outcome: ${escapeHtml(a.execution_outcome)}</div>` : ''}
        </td>
      </tr>
    `,
    )
    .join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(validated.title)} — Technical Remediation Register</title>
  <style>
    @page { size: A4 landscape; margin: 12mm; }
    *, *::before, *::after { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      color: #1E293B; background: #FFFFFF; margin: 0; padding: 0; font-size: 12px; line-height: 1.4;
    }
    .header-banner {
      background: #1E2A4A; color: #FFFFFF; padding: 18px 24px; border-radius: 8px;
      display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px;
    }
    .brand-title { font-size: 20px; font-weight: 700; margin: 0 0 4px 0; }
    .brand-subtitle { font-size: 11px; color: #94A3B8; margin: 0; }
    .reg-badge {
      background: #0FB5A5; color: #FFFFFF; font-size: 11px; font-weight: 700;
      padding: 6px 14px; border-radius: 4px; text-transform: uppercase;
    }
    .metrics-bar {
      display: grid; grid-template-columns: repeat(6, 1fr); gap: 12px; margin-bottom: 20px;
    }
    .metric-cell {
      border: 1px solid #E2E8F0; border-radius: 6px; padding: 12px; background: #F8FAFC; text-align: center;
    }
    .metric-num { font-size: 20px; font-weight: 700; color: #1E2A4A; }
    .metric-lbl { font-size: 10px; font-weight: 600; color: #64748B; text-transform: uppercase; margin-top: 2px; }
    .table-tech {
      width: 100%; border-collapse: collapse; font-size: 11px;
    }
    .table-tech th, .table-tech td {
      border: 1px solid #CBD5E1; padding: 8px 10px; text-align: left;
    }
    .table-tech th { background: #EEF2F6; color: #334155; font-weight: 600; }
    .badge { font-size: 9px; font-weight: 700; padding: 2px 6px; border-radius: 4px; }
    .badge.critical { background: #FEE2E2; color: #991B1B; }
    .badge.high { background: #FFEDD5; color: #9A3412; }
    .badge.medium { background: #FEF3C7; color: #92400E; }
    .badge.low { background: #E0E7FF; color: #3730A3; }
    .footer { margin-top: 30px; padding-top: 12px; border-top: 1px solid #E2E8F0; display: flex; justify-content: space-between; font-size: 10px; color: #94A3B8; }
  </style>
</head>
<body>
  <div class="header-banner">
    <div>
      <div class="brand-title">${escapeHtml(validated.title)}</div>
      <p class="brand-subtitle">Plan ID: ${escapeHtml(validated.plan_id)} (Version ${validated.plan_version}) · ${escapeHtml(validated.branding.product)}</p>
    </div>
    <div class="reg-badge">TECHNICAL REGISTER</div>
  </div>

  <div class="metrics-bar">
    <div class="metric-cell">
      <div class="metric-num">${validated.register_summary.total_actions}</div>
      <div class="metric-lbl">Total Actions</div>
    </div>
    <div class="metric-cell">
      <div class="metric-num" style="color: #0FB5A5;">${validated.register_summary.approved_actions}</div>
      <div class="metric-lbl">Approved</div>
    </div>
    <div class="metric-cell">
      <div class="metric-num">${validated.register_summary.dry_run_passed_actions}</div>
      <div class="metric-lbl">Dry Runs Passed</div>
    </div>
    <div class="metric-cell">
      <div class="metric-num">${validated.register_summary.rollback_validated_actions}</div>
      <div class="metric-lbl">Rollbacks Validated</div>
    </div>
    <div class="metric-cell">
      <div class="metric-num">${validated.register_summary.executed_actions}</div>
      <div class="metric-lbl">Executed</div>
    </div>
    <div class="metric-cell">
      <div class="metric-num">${validated.register_summary.estimated_total_rollback_time_seconds}s</div>
      <div class="metric-lbl">Est. Rollback Time</div>
    </div>
  </div>

  <table class="table-tech">
    <thead>
      <tr>
        <th style="width: 5%;">Seq</th>
        <th style="width: 45%;">Action &amp; Target Blast Radius</th>
        <th style="width: 10%; text-align: center;">Risk Class</th>
        <th style="width: 20%;">Dry Run &amp; Rollback Assurance</th>
        <th style="width: 20%;">Approval &amp; Execution Gate</th>
      </tr>
    </thead>
    <tbody>
      ${actionRowsHtml}
    </tbody>
  </table>

  <div class="footer">
    <div>Generated by ${escapeHtml(validated.signatures.prepared_by.name)} · ${escapeHtml(validated.branding.company)} (${escapeHtml(validated.branding.company_url)})</div>
    <div>Generated At: ${escapeHtml(validated.generated_at)}</div>
  </div>
</body>
</html>`;
}
