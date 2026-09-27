/**
 * Approval History Export contracts, schema validation, and deterministic HTML rendering.
 * Provides formal, tamper-evident audit trails for all human and standing-policy approvals (BR-1, BR-2, FR-6).
 */
import { z } from 'zod';
import { BRANDING } from './schema';

const uuid = z.string().regex(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
const timestamp = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/)
  .refine((v) => Number.isFinite(Date.parse(v)));

export const ApprovalRecordItemSchema = z.object({
  token_id: uuid,
  plan_id: uuid,
  plan_title: z.string().min(1).max(300),
  plan_version: z.number().int().min(1),
  approver_id: uuid,
  approver_name: z.string().min(1).max(100),
  approver_role: z.string().min(1).max(100),
  approval_scopes: z.array(z.string().min(1).max(100)),
  mode: z.enum(['batch', 'individual']),
  action_count: z.number().int().min(1),
  action_types: z.array(z.string().min(1).max(100)),
  dry_run_verified: z.boolean(),
  dry_run_status: z.string().min(1).max(50),
  rollback_validated: z.boolean(),
  reconciliation_statement: z.string().min(1).max(2000).nullable(),
  status: z.enum(['issued', 'consumed', 'revoked', 'expired']),
  issued_at: timestamp,
  expires_at: timestamp,
  consumed_at: timestamp.nullable(),
  revoked_at: timestamp.nullable(),
  signature_preview: z.string().min(8).max(128),
});
export type ApprovalRecordItem = z.infer<typeof ApprovalRecordItemSchema>;

export const ApprovalHistoryExportContentV1Schema = z.object({
  schema_version: z.literal(1),
  kind: z.literal('approval_history_export'),
  export_id: uuid.optional(),
  title: z.string().min(1).max(300),
  tenant_id: uuid,
  tenant_name: z.string().min(1).max(200),
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
  summary: z.object({
    total_records: z.number().int().min(0),
    active_approvals: z.number().int().min(0),
    consumed_approvals: z.number().int().min(0),
    revoked_approvals: z.number().int().min(0),
    standing_policy_approvals: z.number().int().min(0),
    batch_approvals: z.number().int().min(0),
    individual_approvals: z.number().int().min(0),
  }),
  approvals: z.array(ApprovalRecordItemSchema).max(200),
});
export type ApprovalHistoryExportContentV1 = z.infer<typeof ApprovalHistoryExportContentV1Schema>;

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderApprovalHistoryHtml(content: ApprovalHistoryExportContentV1): string {
  const validated = ApprovalHistoryExportContentV1Schema.parse(content);

  const statusBadge = (status: string) => {
    switch (status) {
      case 'consumed':
        return '<span class="status-chip consumed">CONSUMED</span>';
      case 'issued':
        return '<span class="status-chip issued">ACTIVE</span>';
      case 'revoked':
        return '<span class="status-chip revoked">REVOKED</span>';
      default:
        return '<span class="status-chip expired">EXPIRED</span>';
    }
  };

  const recordsHtml = validated.approvals
    .map(
      (appr) => `
      <div class="approval-card">
        <div class="approval-top">
          <div>
            <span class="token-id">TOKEN: ${escapeHtml(appr.token_id.slice(0, 8))}...</span>
            <span class="plan-info">Plan: ${escapeHtml(appr.plan_title)} (v${appr.plan_version})</span>
          </div>
          <div>${statusBadge(appr.status)}</div>
        </div>
        <div class="approval-grid">
          <div>
            <strong>Approver:</strong> ${escapeHtml(appr.approver_name)} (${escapeHtml(appr.approver_role)})<br>
            <strong>Scopes:</strong> ${escapeHtml(appr.approval_scopes.join(', ') || 'Unrestricted')}<br>
            <strong>Mode:</strong> ${escapeHtml(appr.mode.toUpperCase())} (${appr.action_count} action(s))
          </div>
          <div>
            <strong>Dry Run:</strong> ${appr.dry_run_verified ? '✓ Passed (' + escapeHtml(appr.dry_run_status) + ')' : '✗ Not Verified'}<br>
            <strong>Rollback:</strong> ${appr.rollback_validated ? '✓ Validated' : '✗ Unvalidated'}<br>
            <strong>Signature:</strong> <span class="sig-code">${escapeHtml(appr.signature_preview)}</span>
          </div>
        </div>
        <div class="approval-meta">
          Issued: ${escapeHtml(appr.issued_at)} · Expires: ${escapeHtml(appr.expires_at)}
          ${appr.consumed_at ? ` · Consumed: ${escapeHtml(appr.consumed_at)}` : ''}
          ${appr.revoked_at ? ` · Revoked: ${escapeHtml(appr.revoked_at)}` : ''}
        </div>
        ${
          appr.reconciliation_statement
            ? `
          <div class="reconciliation-box">
            <strong>Reconciliation Statement:</strong> ${escapeHtml(appr.reconciliation_statement)}
          </div>
        `
            : ''
        }
      </div>
    `,
    )
    .join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(validated.title)} — Approval History Export</title>
  <style>
    @page { size: A4 portrait; margin: 15mm; }
    *, *::before, *::after { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      color: #1E293B; background: #FFFFFF; margin: 0; padding: 0; font-size: 12px; line-height: 1.5;
    }
    .header-banner {
      background: #1E2A4A; color: #FFFFFF; padding: 22px 28px; border-radius: 8px;
      display: flex; justify-content: space-between; align-items: center; margin-bottom: 22px;
    }
    .brand-title { font-size: 22px; font-weight: 700; margin: 0 0 4px 0; }
    .brand-subtitle { font-size: 11px; color: #94A3B8; margin: 0; }
    .export-badge {
      background: #0FB5A5; color: #FFFFFF; font-size: 11px; font-weight: 700;
      padding: 6px 14px; border-radius: 4px; text-transform: uppercase;
    }
    .metrics-grid {
      display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; margin-bottom: 22px;
    }
    .metric-card {
      border: 1px solid #E2E8F0; border-radius: 6px; padding: 12px; background: #F8FAFC; text-align: center;
    }
    .metric-val { font-size: 22px; font-weight: 700; color: #1E2A4A; }
    .metric-sub { font-size: 10px; font-weight: 600; color: #64748B; text-transform: uppercase; margin-top: 2px; }
    .approval-card {
      border: 1px solid #CBD5E1; border-radius: 6px; padding: 14px; margin-bottom: 12px; background: #FFFFFF; page-break-inside: avoid;
    }
    .approval-top { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
    .token-id { font-family: monospace; font-weight: 700; color: #1E2A4A; margin-right: 8px; }
    .plan-info { color: #475569; font-size: 11px; }
    .status-chip { font-size: 10px; font-weight: 700; padding: 3px 8px; border-radius: 4px; }
    .status-chip.consumed { background: #D1FAE5; color: #065F46; }
    .status-chip.issued { background: #FEF3C7; color: #92400E; }
    .status-chip.revoked { background: #FEE2E2; color: #991B1B; }
    .status-chip.expired { background: #F1F5F9; color: #64748B; }
    .approval-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; font-size: 11px; margin-bottom: 6px; }
    .approval-meta { font-size: 10px; color: #64748B; }
    .sig-code { font-family: monospace; color: #0284C7; font-size: 10px; }
    .reconciliation-box {
      margin-top: 8px; padding: 8px 10px; background: #EEF2F6; border-left: 3px solid #0FB5A5; font-size: 11px;
    }
    .footer { margin-top: 30px; padding-top: 12px; border-top: 1px solid #E2E8F0; display: flex; justify-content: space-between; font-size: 10px; color: #94A3B8; }
  </style>
</head>
<body>
  <div class="header-banner">
    <div>
      <div class="brand-title">${escapeHtml(validated.title)}</div>
      <p class="brand-subtitle">Tenant: ${escapeHtml(validated.tenant_name)} · ${escapeHtml(validated.branding.product)} Approval Audit Ledger</p>
    </div>
    <div class="export-badge">APPROVAL AUDIT EXPORT</div>
  </div>

  <div class="metrics-grid">
    <div class="metric-card">
      <div class="metric-val">${validated.summary.total_records}</div>
      <div class="metric-sub">Total Approvals</div>
    </div>
    <div class="metric-card">
      <div class="metric-val" style="color: #0FB5A5;">${validated.summary.consumed_approvals}</div>
      <div class="metric-sub">Executed / Consumed</div>
    </div>
    <div class="metric-card">
      <div class="metric-val" style="color: #C9A227;">${validated.summary.active_approvals}</div>
      <div class="metric-sub">Active in Queue</div>
    </div>
    <div class="metric-card">
      <div class="metric-val" style="color: #D9534F;">${validated.summary.revoked_approvals}</div>
      <div class="metric-sub">Revoked / Halts</div>
    </div>
  </div>

  ${recordsHtml}

  <div class="footer">
    <div>Exported from ${escapeHtml(validated.branding.product)} · ${escapeHtml(validated.branding.company)} (${escapeHtml(validated.branding.company_url)})</div>
    <div>Generated At: ${escapeHtml(validated.generated_at)}</div>
  </div>
</body>
</html>`;
}
